import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createReviewDemoInstallation, parseReviewDemoArguments } from '../src/review/review-demo-setup.mjs';
import { loadReviewDemoConfiguration, reviewDemoIdentitySha256 } from '../src/review/review-demo-isolation.mjs';
import { createInstallation } from '../src/setup/setup.mjs';
import { runCli } from '../src/cli/cli.mjs';
import { resolveCliInvocation } from '../src/cli/cli-environment.mjs';

const OPTIONS = { origin: 'https://demo-socket.example.test', runtimeId: 'review-demo',
  reviewOrigin: 'https://demo-review.example.test' };
const readJson = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const writeJson = (path, value) => fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'abot-review-setup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'demo') };
}

function fixture(t) {
  const paths = workspace(t);
  const result = createReviewDemoInstallation({ ...OPTIONS, output: paths.output });
  return { ...paths, ...result, env: { ABOT_SOCKET_CONFIG: result.configPath } };
}

test('fresh review setup separates credentials, marks state, and saves working reviewer instructions privately', t => {
  const f = fixture(t);
  const config = readJson(f.configPath);
  const portal = readJson(f.reviewConfigurationPath);
  const connection = readJson(f.runtimeConnectionPath);
  const access = fs.readFileSync(f.reviewAccessPath, 'utf8');
  const password = access.match(/^Password: ([A-Za-z0-9_-]{43})$/m)?.[1];
  assert.ok(password);
  assert.match(access, /Portal: https:\/\/demo-review\.example\.test\/review\n/);
  assert.equal(portal.username, 'reviewer');
  assert.equal(portal.passwordSha256, sha256(password));
  assert.notEqual(password, connection.runtimeToken);
  assert.equal(JSON.stringify(portal).includes(password), false);
  assert.equal(JSON.stringify(config).includes(password), false);
  assert.deepEqual(config.runtimeGrants[0].allowedModes, ['ask']);
  assert.equal(config.runtimeGrants[0].tokenSha256, sha256(connection.runtimeToken));
  for (const path of [f.configPath, f.reviewConfigurationPath, f.reviewAccessPath, f.runtimeConnectionPath]) {
    assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
  }
  for (const path of [f.directory, join(f.directory, 'state')]) assert.equal(fs.statSync(path).mode & 0o7777, 0o700);
  const loaded = loadReviewDemoConfiguration(f.env);
  assert.equal(loaded.socketOrigin, OPTIONS.origin);
  assert.equal(loaded.publicOrigin, OPTIONS.reviewOrigin);
  assert.equal(loaded.stateDirectory, join(f.directory, 'state'));
  const database = new DatabaseSync(join(loaded.stateDirectory, 'auth.sqlite3'), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'review_demo_id'").get().value, portal.demoId);
    assert.equal(database.prepare('SELECT count(*) AS count FROM pairing').get().count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM devices').get().count, 0);
  } finally { database.close(); }
});

test('only identity changes break the binding; demo modes, push and listener port remain configurable', t => {
  const f = fixture(t);
  const original = readJson(f.configPath);
  const enabled = { ...original, port: 8800,
    runtimeGrants: [{ ...original.runtimeGrants[0], allowedModes: ['ask', 'full_access'] }],
    notifications: { delivery: { type: 'gateway', gatewayOrigin: 'https://push.example.test' } } };
  writeJson(f.configPath, enabled);
  assert.doesNotThrow(() => loadReviewDemoConfiguration(f.env));
  for (const change of [
    { ...enabled, publicOrigin: 'https://other.example.test' },
    { ...enabled, stateDirectory: '../other-state' },
    { ...enabled, runtimeGrants: [{ ...enabled.runtimeGrants[0], runtimeId: 'different' }] },
    { ...enabled, runtimeGrants: [{ ...enabled.runtimeGrants[0], tokenSha256: 'a'.repeat(64) }] },
    { ...enabled, port: 8789 },
  ]) {
    writeJson(f.configPath, change);
    assert.throws(() => loadReviewDemoConfiguration(f.env));
  }
});

test('copied portal configuration cannot open or modify an ordinary installation', t => {
  const f = fixture(t);
  const ordinary = createInstallation({ ...OPTIONS, output: join(f.root, 'ordinary') });
  const databasePath = join(ordinary.directory, 'state', 'auth.sqlite3');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let ownerId;
  try { ownerId = database.prepare("SELECT value FROM metadata WHERE key = 'owner_id'").get().value; }
  finally { database.close(); }
  const copied = { ...readJson(f.reviewConfigurationPath), ownerId,
    configSha256: reviewDemoIdentitySha256(readJson(ordinary.configPath)) };
  fs.writeFileSync(join(ordinary.directory, 'review-portal.json'), JSON.stringify(copied), { mode: 0o600 });
  const before = fs.readFileSync(databasePath);
  assert.throws(() => loadReviewDemoConfiguration({ ABOT_SOCKET_CONFIG: ordinary.configPath }));
  assert.deepEqual(fs.readFileSync(databasePath), before);
});

test('missing or mismatched owner/marker state is rejected without state creation or repair', t => {
  const f = fixture(t);
  const portal = readJson(f.reviewConfigurationPath);
  for (const patch of [{ ownerId: '00000000-0000-0000-0000-000000000000' }, { demoId: 'x'.repeat(43) }]) {
    writeJson(f.reviewConfigurationPath, { ...portal, ...patch });
    assert.throws(() => loadReviewDemoConfiguration(f.env));
  }
  writeJson(f.reviewConfigurationPath, portal);
  const state = join(f.directory, 'state');
  const saved = join(f.root, 'saved-state');
  fs.renameSync(state, saved);
  assert.throws(() => loadReviewDemoConfiguration(f.env));
  assert.equal(fs.existsSync(state), false);
});

test('private files and directories reject broad permissions, symlinks, hardlinks and caller-selected state', t => {
  const f = fixture(t);
  fs.chmodSync(f.reviewConfigurationPath, 0o644);
  assert.throws(() => loadReviewDemoConfiguration(f.env));
  fs.chmodSync(f.reviewConfigurationPath, 0o600);
  const hardlink = join(f.root, 'portal-link');
  fs.linkSync(f.reviewConfigurationPath, hardlink);
  assert.throws(() => loadReviewDemoConfiguration(f.env));
  fs.unlinkSync(hardlink);
  const alias = join(f.root, 'linked-demo');
  fs.symlinkSync(f.directory, alias);
  assert.throws(() => loadReviewDemoConfiguration({ ABOT_SOCKET_CONFIG: join(alias, 'config.json') }));
  assert.throws(() => loadReviewDemoConfiguration({ ABOT_SOCKET_CONFIG: f.reviewConfigurationPath }));
  const config = readJson(f.reviewConfigurationPath);
  writeJson(f.reviewConfigurationPath, { ...config, stateDirectory: '/private/tmp/unrelated-state' });
  assert.throws(() => loadReviewDemoConfiguration(f.env));
});

test('fresh setup never overwrites an existing directory or uses symlink ancestors', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.configPath);
  assert.throws(() => createReviewDemoInstallation({ ...OPTIONS, output: f.directory }));
  assert.deepEqual(fs.readFileSync(f.configPath), original);
  const alias = join(f.root, 'alias');
  fs.symlinkSync(f.directory, alias);
  assert.throws(() => createReviewDemoInstallation({ ...OPTIONS, output: join(alias, 'nested') }));
  assert.equal(fs.existsSync(join(f.directory, 'nested')), false);
});

test('late write failure removes only newly owned demo files and permits a fresh retry', t => {
  const f = workspace(t);
  const unrelated = join(f.root, 'keep.txt');
  fs.writeFileSync(unrelated, 'keep');
  const failure = new Error('simulated private access write failure');
  const io = { ...fs, writeFileSync(descriptor, content) {
    if (!String(content).startsWith('ABot isolated review demo')) return fs.writeFileSync(descriptor, content);
    fs.writeFileSync(descriptor, 'partial');
    throw failure;
  } };
  assert.throws(() => createReviewDemoInstallation({ ...OPTIONS, output: f.output }, { io }), error => error === failure);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.doesNotThrow(() => createReviewDemoInstallation({ ...OPTIONS, output: f.output }));
});

test('setup CLI prints paths only and rejects configuration reuse and colliding endpoints', t => {
  const f = workspace(t);
  const args = ['--output', f.output, '--origin', OPTIONS.origin, '--runtime-id', OPTIONS.runtimeId,
    '--review-origin', OPTIONS.reviewOrigin];
  const output = [];
  assert.equal(runCli(['review-setup', ...args], { out: line => output.push(line), error: line => output.push(line) }), 0);
  const password = fs.readFileSync(join(f.output, 'review-access.txt'), 'utf8').match(/^Password: (.+)$/m)[1];
  assert.equal(output.join('\n').includes(password), false);
  assert.equal(output.join('\n').includes(readJson(join(f.output, 'runtime-connection.json')).runtimeToken), false);
  assert.throws(() => resolveCliInvocation(['review-setup', ...args, '--config', join(f.output, 'config.json')], {}));
  for (const suffix of [['--review-port', '8788'], ['--review-port', '80'], ['--review-port', '8789bad']]) {
    assert.throws(() => createReviewDemoInstallation(parseReviewDemoArguments([...args, ...suffix])));
  }
  assert.throws(() => createReviewDemoInstallation({ ...OPTIONS, output: join(f.root, 'collision'), reviewOrigin: OPTIONS.origin }));
  for (const invalid of [[], [...args, '--state-directory', '/private/tmp/state'], [...args, '--origin', OPTIONS.origin]]) {
    assert.throws(() => parseReviewDemoArguments(invalid));
  }
});
