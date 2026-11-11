import { createHash, randomBytes } from 'node:crypto';
import * as filesystem from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AuthDatabase } from '../auth/auth-database.mjs';
import { prepareInstallation } from '../setup/setup.mjs';
import { writePrivateInstallation } from '../setup/setup-files.mjs';
import { assertReviewDemoParentPath, assertReviewEndpointSeparation, reviewDemoIdentitySha256 } from './review-demo-isolation.mjs';

const OPTIONS = new Map([['--output', 'output'], ['--origin', 'origin'], ['--runtime-id', 'runtimeId'],
  ['--review-origin', 'reviewOrigin'], ['--port', 'port'], ['--review-port', 'reviewPort']]);

export function parseReviewDemoArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = OPTIONS.get(args[index]);
    const value = args[index + 1];
    if (!name || Object.hasOwn(options, name) || typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error('Provide each review setup option once with a value');
    }
    if (name === 'port' || name === 'reviewPort') {
      if (!/^\d{1,5}$/.test(value)) throw new Error('Invalid review listener port');
      options[name] = Number(value);
      continue;
    }
    options[name] = value;
  }
  for (const name of ['output', 'origin', 'runtimeId', 'reviewOrigin']) {
    if (!options[name]) throw new Error('Missing required review setup option');
  }
  return options;
}

function writePrivateReviewFile(path, content, created, io) {
  const descriptor = io.openSync(path, 'wx', 0o600);
  created.push(path);
  try { io.writeFileSync(descriptor, content); io.fsyncSync(descriptor); }
  finally { io.closeSync(descriptor); }
}

function removeOwnedFailedDemo(directory, created, stateCreated, io) {
  const failures = [];
  for (const path of created.reverse()) {
    try { io.unlinkSync(path); } catch (error) { failures.push(error); }
  }
  if (stateCreated) {
    const state = join(directory, 'state');
    for (const name of ['auth.sqlite3-journal', 'auth.sqlite3']) {
      try { io.unlinkSync(join(state, name)); } catch (error) { if (error.code !== 'ENOENT') failures.push(error); }
    }
    try { io.rmdirSync(state); } catch (error) { failures.push(error); }
  }
  try { io.rmdirSync(directory); } catch (error) { failures.push(error); }
  return failures;
}

/** Local file preparation only; no existing installation, services or runtime is reused. */
export function createReviewDemoInstallation(options, { io = filesystem } = {}) {
  if (typeof options.output !== 'string' || !options.output.trim()) throw new Error('Choose a new private demo directory');
  const bundle = prepareInstallation(options);
  const port = options.reviewPort ?? 8789;
  assertReviewEndpointSeparation(bundle.config, options.reviewOrigin, port);
  const directory = resolve(options.output);
  assertReviewDemoParentPath(dirname(directory));
  writePrivateInstallation(directory, bundle, io);
  const created = [join(directory, 'config.json'), join(directory, 'runtime-connection.json')];
  let stateCreated = false;
  try {
    const stateDirectory = join(directory, 'state');
    io.mkdirSync(stateDirectory, { mode: 0o700 });
    stateCreated = true;
    const database = new AuthDatabase(stateDirectory);
    const demoId = randomBytes(32).toString('base64url');
    let ownerId;
    try {
      ownerId = database.ownerId;
      database.transaction(() => database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
        .run('review_demo_id', demoId));
    } finally { database.close(); }
    const password = randomBytes(32).toString('base64url');
    const portal = { version: 1, purpose: 'review-demo', demoId, ownerId,
      configSha256: reviewDemoIdentitySha256(bundle.config), publicOrigin: options.reviewOrigin,
      port, username: 'reviewer', passwordSha256: createHash('sha256').update(password).digest('hex') };
    writePrivateReviewFile(join(directory, 'review-portal.json'), `${JSON.stringify(portal, null, 2)}\n`, created, io);
    writePrivateReviewFile(join(directory, 'review-access.txt'),
      `ABot isolated review demo\nPortal: ${portal.publicOrigin}/review\nUsername: reviewer\nPassword: ${password}\n\n` +
      'Keep these reviewer credentials private. The portal issues normal single-use 5-minute pairing details.\n' +
      'The demo runtime must use separate storage and synthetic data; this setup does not create or isolate a runtime.\n', created, io);
    return { directory, configPath: join(directory, 'config.json'),
      runtimeConnectionPath: join(directory, 'runtime-connection.json'),
      reviewConfigurationPath: join(directory, 'review-portal.json'),
      reviewAccessPath: join(directory, 'review-access.txt') };
  } catch (error) {
    const failures = removeOwnedFailedDemo(directory, created, stateCreated, io);
    if (failures.length) throw new AggregateError([error, ...failures], 'Review setup failed and owned cleanup was incomplete');
    throw error;
  }
}
