import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallation, prepareInstallation } from '../src/setup/setup.mjs';
import { parseSetupArguments } from '../src/cli/cli-arguments.mjs';
import { runCli } from '../src/cli/cli.mjs';
import { digestToken, resolveRuntimeCredential } from '../src/auth/runtime-credentials.mjs';
import { loadConfiguration } from '../src/config/config.mjs';
import { AuthService } from '../src/auth/auth.mjs';

const OPTIONS = { origin: 'https://socket.example.test:9443', runtimeId: 'workstation' };

function workspace(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-setup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'installation') };
}

test('setup produces independent high-entropy runtime keys bound to one identity with Ask only', () => {
  const first = prepareInstallation(OPTIONS);
  const second = prepareInstallation(OPTIONS);
  assert.match(first.runtimeConnection.runtimeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.runtimeConnection.runtimeToken, second.runtimeConnection.runtimeToken);
  assert.equal(first.config.stateDirectory, './state');
  assert.equal(first.runtimeConnection.agentBridgeUrl, 'wss://socket.example.test:9443/agent-bridge');
  assert.equal(first.config.runtimeGrants[0].tokenSha256, digestToken(first.runtimeConnection.runtimeToken));
  assert.equal(JSON.stringify(first.config).includes(first.runtimeConnection.runtimeToken), false);
  assert.deepEqual(first.config.runtimeGrants[0].allowedModes, ['ask']);
  assert.equal(resolveRuntimeCredential(`Bearer ${first.runtimeConnection.runtimeToken}`,
    first.config.runtimeGrants).runtimeId, OPTIONS.runtimeId);
});

test('setup files are private, loadable, and never overwrite an existing installation', (t) => {
  const { output } = workspace(t);
  const result = createInstallation({ ...OPTIONS, output });
  assert.equal(statSync(output).mode & 0o777, 0o700);
  for (const path of [result.configPath, result.runtimeConnectionPath]) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const before = readFileSync(result.configPath, 'utf8');
  const config = loadConfiguration({ ABOT_SOCKET_CONFIG: result.configPath });
  assert.equal(config.stateDirectory, join(output, 'state'));
  assert.match(result.pairing.code, /^\d{6}$/);
  assert.match(result.pairing.pairingId, /^[A-Za-z0-9_-]{32}$/);
  assert.throws(() => createInstallation({ ...OPTIONS, output }));
  assert.equal(readFileSync(result.configPath, 'utf8'), before);
});

test('setup rejects symlink targets and invalid configuration before creating a directory', (t) => {
  const { root, output } = workspace(t);
  const target = join(root, 'target');
  mkdirSync(target); symlinkSync(target, output);
  assert.throws(() => createInstallation({ ...OPTIONS, output }));
  for (const override of [{ origin: 'http://example.test' }, { runtimeId: 'bad runtime' }, { port: 80 }]) {
    assert.throws(() => prepareInstallation({ ...OPTIONS, ...override }));
  }
});

test('setup CLI rejects secret/unknown/duplicate/missing arguments and malformed ports', () => {
  for (const args of [['--mail-token', 'secret'], ['--output'], ['--port', '8788oops'],
    ['--output', 'one', '--output', 'two'], ['--origin', '--sender']]) {
    assert.throws(() => parseSetupArguments(args));
  }
});

test('CLI prints temporary pairing only; setup, reissue, device list and revoke are local', (t) => {
  const { output } = workspace(t);
  const logs = [];
  const io = { out: (line) => logs.push(line), error: (line) => logs.push(line) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden in config check'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(runCli(['setup', '--output', output, '--origin', OPTIONS.origin, '--runtime-id', OPTIONS.runtimeId], io), 0);
  const secret = JSON.parse(readFileSync(join(output, 'runtime-connection.json'), 'utf8')).runtimeToken;
  assert.equal(runCli(['check-config'], { ...io, env: {
    ABOT_SOCKET_CONFIG: join(output, 'config.json'),
  } }), 0);
  assert.equal(logs.join('\n').includes(secret), false);
  const first = JSON.parse(logs.find((line) => line.startsWith('{')));
  const env = { ABOT_SOCKET_CONFIG: join(output, 'config.json') };
  logs.length = 0;
  assert.equal(runCli(['pair'], { ...io, env }), 0);
  const next = JSON.parse(logs.find((line) => line.startsWith('{')));
  assert.notEqual(next.pairingId, first.pairingId);
  const auth = new AuthService({ stateDirectory: join(output, 'state') });
  try {
    assert.throws(() => auth.redeemPairing({ ...first, deviceName: 'Test phone' }, 'fixture'));
    const session = auth.redeemPairing({ ...next, deviceName: 'Test phone' }, 'fixture');
    logs.length = 0;
    assert.equal(runCli(['devices'], { ...io, env }), 0);
    assert.equal(JSON.parse(logs[0]).devices[0].id, session.session.id);
    assert.equal(logs.join('\n').includes(session.token), false);
    assert.equal(runCli(['revoke', session.session.id], { ...io, env }), 0);
    assert.equal(auth.authenticate(session.token), null);
  } finally { auth.close(); }
  assert.equal(runCli(['check-config'], { ...io, env: { ABOT_SOCKET_CONFIG: 'missing/SECRET-CONTENT' } }), 1);
  assert.equal(logs.join('\n').includes('SECRET-CONTENT'), false);
});
