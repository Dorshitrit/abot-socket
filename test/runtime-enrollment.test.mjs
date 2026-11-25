import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInstallation } from '../src/setup/setup.mjs';
import { addRuntime } from '../src/setup/runtime-enrollment.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { digestToken } from '../src/auth/runtime-credentials.mjs';

const binary = fileURLToPath(new URL('../bin/abot-socket.mjs', import.meta.url));

function enrollmentFixture(t) {
  const root = filesystem.realpathSync(filesystem.mkdtempSync(join(tmpdir(), 'abot-runtime-enroll-')));
  t.after(() => filesystem.rmSync(root, { recursive: true, force: true }));
  const installation = createInstallation({ output: join(root, 'installation'),
    origin: 'https://socket.example.test:9443', runtimeId: 'personal' });
  const config = JSON.parse(filesystem.readFileSync(installation.configPath, 'utf8'));
  config.runtimeGrants[0].allowedModes = ['ask', 'full_access'];
  config.runtimeGrants.push({ runtimeId: 'apple-review', tokenSha256: digestToken('existing-private-fixture'), allowedModes: ['ask', 'full_plus'] });
  config.notifications = { delivery: { type: 'fcm', serviceAccountFile: './private/firebase.json' } };
  filesystem.writeFileSync(installation.configPath, JSON.stringify(config, null, 2) + '\n');
  const stateDirectory = join(installation.directory, 'state');
  const auth = new AuthService({ stateDirectory });
  const device = auth.redeemPairing(installation.pairing, 'fixture');
  const pending = auth.createPairing(); auth.close();
  return { ...installation, root, config, stateDirectory, device, pending,
    databasePath: join(stateDirectory, 'auth.sqlite3'), output: join(root, 'new-runtime'),
    env: { ABOT_SOCKET_CONFIG: installation.configPath } };
}

function options(f, fields = {}) { return { runtimeId: 'third-computer', output: f.output, ...fields }; }
function rawConfig(f) { return filesystem.readFileSync(f.configPath); }
function cleanOwnArtifacts(f) {
  assert.equal(filesystem.existsSync(f.output), false);
  assert.equal(filesystem.existsSync(`${f.configPath}.add-runtime.lock`), false);
  assert.equal(filesystem.readdirSync(dirname(f.configPath)).some(name => name.startsWith('.add-runtime-')), false);
}

test('actual add-runtime CLI adds Ask-only third computer, keeps grants/raw paths and never opens pairing DB', t => {
  const f = enrollmentFixture(t); const database = filesystem.readFileSync(f.databasePath);
  const blocker = join(f.stateDirectory, 'auth-must-not-be-opened');
  filesystem.writeFileSync(blocker, 'fixture blocks AuthService state validation', { mode: 0o600 });
  const run = spawnSync(process.execPath, [binary, 'add-runtime', '--config', f.configPath,
    '--runtime-id', 'third-computer', '--output', f.output], { cwd: f.root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const config = JSON.parse(rawConfig(f));
  const connectionPath = join(f.output, 'runtime-connection.json');
  const connection = JSON.parse(filesystem.readFileSync(connectionPath, 'utf8'));
  assert.deepEqual(config.runtimeGrants.slice(0, 2), f.config.runtimeGrants);
  assert.deepEqual(config.runtimeGrants[2], { runtimeId: 'third-computer', tokenSha256: digestToken(connection.runtimeToken), allowedModes: ['ask'] });
  assert.deepEqual({ ...config, runtimeGrants: f.config.runtimeGrants }, f.config);
  assert.equal(config.stateDirectory, './state'); assert.equal(config.notifications.delivery.serviceAccountFile, './private/firebase.json');
  assert.equal(connection.agentBridgeUrl, 'wss://socket.example.test:9443/agent-bridge');
  assert.match(connection.runtimeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((run.stdout + run.stderr + rawConfig(f)).includes(connection.runtimeToken), false);
  assert.equal(filesystem.statSync(f.output).mode & 0o777, 0o700);
  for (const path of [connectionPath, f.configPath]) assert.equal(filesystem.statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(filesystem.readFileSync(f.databasePath), database);
  assert.match(run.stdout, /No service was started or restarted/);
  filesystem.unlinkSync(blocker);
  const auth = new AuthService({ stateDirectory: f.stateDirectory });
  try { assert.equal(auth.authenticate(f.device.token).sessionId, f.device.session.id); assert.ok(auth.redeemPairing(f.pending, 'fixture').token); }
  finally { auth.close(); }
});

test('duplicate identifiers, existing output files/directories and symlinks cannot replace existing data', t => {
  for (const kind of ['duplicate', 'file', 'directory', 'output-symlink', 'config-symlink']) {
    const f = enrollmentFixture(t); const original = rawConfig(f);
    if (kind === 'file') filesystem.writeFileSync(f.output, 'preserve file');
    if (kind === 'directory') filesystem.mkdirSync(f.output);
    if (kind === 'output-symlink') filesystem.symlinkSync(f.directory, f.output);
    const env = { ...f.env };
    if (kind === 'config-symlink') { env.ABOT_SOCKET_CONFIG = join(f.root, 'config-link'); filesystem.symlinkSync(f.configPath, env.ABOT_SOCKET_CONFIG); }
    assert.throws(() => addRuntime(options(f, kind === 'duplicate' ? { runtimeId: 'personal' } : {}), env));
    assert.deepEqual(rawConfig(f), original);
    if (kind === 'file') assert.equal(filesystem.readFileSync(f.output, 'utf8'), 'preserve file');
    if (kind === 'output-symlink') assert.equal(filesystem.lstatSync(f.output).isSymbolicLink(), true);
    assert.equal(filesystem.existsSync(`${f.configPath}.add-runtime.lock`), false);
  }
});

test('sixteen existing grants reject another without creating credentials or touching configuration', t => {
  const f = enrollmentFixture(t);
  f.config.runtimeGrants = Array.from({ length: 16 }, (_, i) => ({ runtimeId: `computer-${i}`, tokenSha256: digestToken(`fixture-${i}`), allowedModes: ['ask'] }));
  filesystem.writeFileSync(f.configPath, JSON.stringify(f.config));
  const original = rawConfig(f);
  assert.throws(() => addRuntime(options(f), f.env));
  assert.deepEqual(rawConfig(f), original); cleanOwnArtifacts(f);
});

test('partial connection/config writes and failed atomic rename clean only their own prepared files', t => {
  for (const failure of ['connection-write', 'config-write', 'rename']) {
    const f = enrollmentFixture(t); const original = rawConfig(f); const descriptors = new Map();
    const io = { ...filesystem,
      openSync(path, ...args) { const fd = filesystem.openSync(path, ...args); descriptors.set(fd, String(path)); return fd; },
      writeFileSync(fd, value, ...args) {
        const path = descriptors.get(fd) ?? '';
        const trigger = failure === 'connection-write' ? path.endsWith('runtime-connection.json') : failure === 'config-write' && path.endsWith('.tmp');
        if (trigger) { filesystem.writeFileSync(fd, 'partial'); throw new Error('injected write failure'); }
        return filesystem.writeFileSync(fd, value, ...args);
      },
      renameSync(...args) { if (failure === 'rename') throw new Error('injected rename failure'); return filesystem.renameSync(...args); },
    };
    assert.throws(() => addRuntime(options(f), f.env, io), /injected/);
    assert.deepEqual(rawConfig(f), original); cleanOwnArtifacts(f);
  }
});

test('concurrent manual configuration edit is retained instead of overwritten', t => {
  const f = enrollmentFixture(t); const edited = Buffer.from(JSON.stringify({ ...f.config, port: 9899 }) + '\n');
  let changed = false;
  const io = { ...filesystem, openSync(path, ...args) {
    const fd = filesystem.openSync(path, ...args);
    if (!changed && String(path).endsWith('runtime-connection.json')) { changed = true; filesystem.writeFileSync(f.configPath, edited); }
    return fd;
  } };
  assert.throws(() => addRuntime(options(f), f.env, io), /changed during enrollment/);
  assert.deepEqual(rawConfig(f), edited); cleanOwnArtifacts(f);
});

test('exclusive output race preserves foreign file instead of deleting it during cleanup', t => {
  const f = enrollmentFixture(t); const original = rawConfig(f);
  const connectionPath = join(f.output, 'runtime-connection.json');
  const io = { ...filesystem, openSync(path, ...args) {
    if (path === connectionPath && args[0] === 'wx') filesystem.writeFileSync(path, 'foreign concurrent file', { flag: 'wx', mode: 0o600 });
    return filesystem.openSync(path, ...args);
  } };
  assert.throws(() => addRuntime(options(f), f.env, io));
  assert.deepEqual(rawConfig(f), original);
  assert.equal(filesystem.readFileSync(connectionPath, 'utf8'), 'foreign concurrent file');
  assert.equal(filesystem.existsSync(`${f.configPath}.add-runtime.lock`), false);
});

test('post-commit directory fsync failure keeps valid credentials and reports committed state', t => {
  const f = enrollmentFixture(t); let committed = false;
  const io = { ...filesystem,
    renameSync(...args) { const result = filesystem.renameSync(...args); committed = true; return result; },
    fsyncSync(fd) { if (committed) throw new Error('injected directory sync failure'); return filesystem.fsyncSync(fd); },
  };
  assert.throws(() => addRuntime(options(f), f.env, io), { code: 'enrollment_committed_unconfirmed' });
  const config = JSON.parse(rawConfig(f)); const connection = JSON.parse(filesystem.readFileSync(join(f.output, 'runtime-connection.json'), 'utf8'));
  assert.equal(config.runtimeGrants.at(-1).tokenSha256, digestToken(connection.runtimeToken));
  assert.deepEqual(config.runtimeGrants.slice(0, 2), f.config.runtimeGrants);
  assert.equal(filesystem.existsSync(`${f.configPath}.add-runtime.lock`), false);
});

test('manual edit between the parsed configuration and captured bytes is rejected before output creation', t => {
  const f = enrollmentFixture(t); const edited = Buffer.from(JSON.stringify({ ...f.config, port: 9898 }) + '\n');
  let changed = false;
  const io = { ...filesystem, readFileSync(path, ...args) {
    if (!changed && path === f.configPath) { changed = true; filesystem.writeFileSync(path, edited); }
    return filesystem.readFileSync(path, ...args);
  } };
  assert.throws(() => addRuntime(options(f), f.env, io), /changed during enrollment/);
  assert.deepEqual(rawConfig(f), edited); cleanOwnArtifacts(f);
});

test('another enrollment lock is neither bypassed nor removed', t => {
  const f = enrollmentFixture(t); const original = rawConfig(f);
  const lock = `${f.configPath}.add-runtime.lock`;
  filesystem.writeFileSync(lock, 'other enrollment owner', { mode: 0o600 });
  assert.throws(() => addRuntime(options(f), f.env));
  assert.deepEqual(rawConfig(f), original); assert.equal(filesystem.existsSync(f.output), false);
  assert.equal(filesystem.readFileSync(lock, 'utf8'), 'other enrollment owner');
});
