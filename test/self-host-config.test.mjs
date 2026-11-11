import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname as fixtureDirectory } from 'node:path';
import { loadConfiguration } from '../src/config/config.mjs';
import { validateConfiguration } from '../src/config/config-validation.mjs';

const CONFIG = {
  stateDirectory: './state', publicOrigin: 'https://socket.example.test',
  runtimeGrants: [{ runtimeId: 'workstation', tokenSha256: 'a'.repeat(64) }],
};

function fixture(t, contents = JSON.stringify(CONFIG)) {
  const directory = mkdtempSync(join(tmpdir(), 'abot-self-host-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  writeFileSync(path, contents, { mode: 0o600 });
  return { directory, path, env: { ABOT_SOCKET_CONFIG: path } };
}

test('configuration aliases resolve the same state directory without a mail credential', (t) => {
  const { path, env } = fixture(t);
  const expected = loadConfiguration(env);
  assert.deepEqual(loadConfiguration({ SOCKET_V2_CONFIG: path }), expected);
  assert.deepEqual(loadConfiguration({ ...env, SOCKET_V2_CONFIG: path }), expected);
  assert.equal(expected.stateDirectory, join(fixtureDirectory(path), 'state'));
  assert.deepEqual(expected.runtimeGrants[0].allowedModes, ['ask']);
});

test('conflicting aliases fail closed without disclosing the values', (t) => {
  const { env } = fixture(t);
  const privatePath = '/private/example-not-a-real-secret-config.json';
  assert.throws(() => loadConfiguration({ ...env, SOCKET_V2_CONFIG: privatePath }), (error) => {
    assert.match(error.message, /Conflicting/);
    assert.ok(!error.message.includes(privatePath));
    return true;
  });
});

test('empty preferred config alias permits legacy path without a default', (t) => {
  const { path } = fixture(t);
  const config = loadConfiguration({ ABOT_SOCKET_CONFIG: '', SOCKET_V2_CONFIG: path });
  assert.equal(config.stateDirectory, join(fixtureDirectory(path), 'state'));
  assert.throws(() => loadConfiguration({}), /Set ABOT_SOCKET_CONFIG/);
});

test('private configuration loader rejects symlinks, directories, size and mode violations', (t) => {
  const { path, directory, env } = fixture(t);
  const link = join(directory, 'link.json');
  symlinkSync(path, link);
  for (const invalidPath of [link, directory]) {
    assert.throws(() => loadConfiguration({ ...env, ABOT_SOCKET_CONFIG: invalidPath }), /private file/);
  }
  chmodSync(path, 0o644);
  assert.throws(() => loadConfiguration(env), /private file/);
  chmodSync(path, 0o600);
  writeFileSync(path, ' '.repeat(32_769));
  assert.throws(() => loadConfiguration(env), /private file/);
});

test('malformed configuration never appears in thrown parse errors', (t) => {
  const marker = 'DUMMY_PRIVATE_VALUE_DO_NOT_ECHO';
  const { env } = fixture(t, `{"mail":${marker}}`);
  assert.throws(() => loadConfiguration(env), (error) => {
    assert.ok(!error.message.includes(marker));
    assert.match(error.message, /valid JSON/);
    return true;
  });
});

test('configuration rejects obsolete mail fields instead of retaining a bypass', () => {
  for (const legacy of [{ allowedEmail: 'owner@example.test' }, { mail: { provider: 'resend' } }]) {
    assert.throws(() => validateConfiguration({ ...CONFIG, ...legacy }), /unsupported/);
  }
  assert.equal(validateConfiguration(CONFIG).stateDirectory, './state');
});

test('configuration rejects missing state, malformed origin, grants and port', () => {
  for (const stateDirectory of ['', undefined, 'path\0bad', 123]) {
    assert.throws(() => validateConfiguration({ ...CONFIG, stateDirectory }), /stateDirectory/);
  }
  for (const publicOrigin of ['http://socket.example.test', 'https://socket.example.test/path',
    'https://name:password@socket.example.test', 'secret:not-an-origin']) {
    assert.throws(() => validateConfiguration({ ...CONFIG, publicOrigin }), /canonical HTTPS/);
  }
  assert.throws(() => validateConfiguration({ ...CONFIG, runtimeGrants: [] }), /runtime grants/);
  assert.throws(() => validateConfiguration({ ...CONFIG, port: 80 }), /port/);
});

test('notification delivery defaults off and FCM file paths resolve relative to the private config', t => {
  assert.deepEqual(validateConfiguration(CONFIG).notifications, { delivery: { type: 'disabled' } });
  const configured = { ...CONFIG, notifications: { delivery: { type: 'fcm', serviceAccountFile: './sender.json' } } };
  const f = fixture(t, JSON.stringify(configured));
  assert.equal(loadConfiguration(f.env).notifications.delivery.serviceAccountFile, join(f.directory, 'sender.json'));
  assert.throws(() => validateConfiguration({ ...CONFIG, notifications: { endpoint: 'https://untrusted.invalid' } }));
  assert.throws(() => validateConfiguration({ ...CONFIG, notifications: { delivery: { type: 'fcm', privateKey: 'inline-secret' } } }));
});
