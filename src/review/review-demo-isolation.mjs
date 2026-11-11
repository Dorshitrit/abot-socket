import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivateStateDirectory, assertSameDatabaseFile } from '../auth/auth-storage-path.mjs';
import { validateConfiguration } from '../config/config-validation.mjs';

const MAX_PRIVATE_BYTES = 32_768;
const PORTAL_KEYS = ['version', 'purpose', 'demoId', 'ownerId', 'configSha256',
  'publicOrigin', 'port', 'username', 'passwordSha256'];
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Bind only the demo identity; operators may configure its modes and push later. */
export function reviewDemoIdentitySha256(config) {
  const runtimeGrants = config.runtimeGrants.map(({ runtimeId, tokenSha256 }) => ({ runtimeId, tokenSha256 }))
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  return digest(JSON.stringify({ publicOrigin: config.publicOrigin,
    stateDirectory: config.stateDirectory, runtimeGrants }));
}

export function assertReviewEndpointSeparation(socketConfig, publicOrigin, port) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { /* Validated below. */ }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new Error('Review portal requires a canonical HTTPS origin');
  }
  if (publicOrigin === socketConfig.publicOrigin) throw new Error('Socket and review origins must differ');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === socketConfig.port) {
    throw new Error('Socket and review listener ports must differ and be unprivileged');
  }
}

export function assertReviewDemoParentPath(directory) {
  let current = parse(directory).root;
  for (const component of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe demo installation path');
  }
}

function assertPrivateDemoDirectory(directory) {
  assertReviewDemoParentPath(directory);
  const stat = lstatSync(directory);
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('Demo installation must be private and owned by the current user');
  }
}

function readPrivateDemoJson(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_PRIVATE_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_PRIVATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_PRIVATE_BYTES) throw new Error();
    return JSON.parse(bytes.toString('utf8', 0, length));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function validatePortalRecord(value, socketConfig) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== PORTAL_KEYS.length || Object.keys(value).some(key => !PORTAL_KEYS.includes(key))) {
    throw new Error('Invalid review portal configuration');
  }
  if (value.version !== 1 || value.purpose !== 'review-demo' || value.username !== 'reviewer' ||
      typeof value.demoId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.demoId) ||
      typeof value.ownerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.ownerId)) {
    throw new Error('Invalid review demo identity');
  }
  for (const key of ['configSha256', 'passwordSha256']) {
    if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) throw new Error('Invalid review credential binding');
  }
  assertReviewEndpointSeparation(socketConfig, value.publicOrigin, value.port);
  if (value.configSha256 !== reviewDemoIdentitySha256(socketConfig)) throw new Error('Demo socket identity changed');
}

function assertMarkedDemoDatabase(stateDirectory, portal) {
  assertPrivateStateDirectory(stateDirectory);
  const path = join(stateDirectory, 'auth.sqlite3');
  const prepared = { path, stat: lstatSync(path) };
  // Never instantiate AuthDatabase here: it can initialize or migrate state.
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assertSameDatabaseFile(stateDirectory, prepared);
    if (database.prepare('PRAGMA application_id').get().application_id !== 0x41425341) throw new Error();
    const read = database.prepare('SELECT value FROM metadata WHERE key = ?');
    if (read.get('review_demo_id')?.value !== portal.demoId || read.get('owner_id')?.value !== portal.ownerId) {
      throw new Error('State does not belong to this review demo');
    }
    assertSameDatabaseFile(stateDirectory, prepared);
  } finally { database.close(); }
}

function selectedDemoConfiguration(env) {
  const primary = env.ABOT_SOCKET_CONFIG;
  const legacy = env.SOCKET_V2_CONFIG;
  if (primary && legacy && primary !== legacy) throw new Error('Conflicting demo configuration paths');
  const value = primary || legacy;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Choose a private demo config.json');
  }
  const path = resolve(value);
  if (basename(path) !== 'config.json') throw new Error('Choose the demo config.json');
  return path;
}

/** Separate-process gate: fixed siblings and existing marked state only. */
export function loadReviewDemoConfiguration(env = {}) {
  try {
    const configPath = selectedDemoConfiguration(env);
    const directory = dirname(configPath);
    assertPrivateDemoDirectory(directory);
    const socketConfig = validateConfiguration(readPrivateDemoJson(configPath));
    if (socketConfig.stateDirectory !== './state') throw new Error('Demo state must remain its fixed sibling');
    const portal = readPrivateDemoJson(join(directory, 'review-portal.json'));
    validatePortalRecord(portal, socketConfig);
    const stateDirectory = join(directory, 'state');
    assertMarkedDemoDatabase(stateDirectory, portal);
    return Object.freeze({ ...portal, socketOrigin: socketConfig.publicOrigin, stateDirectory });
  } catch {
    throw new Error('Review portal requires a private marked demo installation with matching socket and state identities');
  }
}
