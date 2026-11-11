import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printInstallation, printPairing } from '../src/cli/cli-output.mjs';
import { runCli } from '../src/cli/cli.mjs';
import { runEntry } from '../src/cli/cli-entry.mjs';
import { runSetupWizard } from '../src/setup/setup-wizard.mjs';
import { createInstallation } from '../src/setup/setup.mjs';
import { AuthService } from '../src/auth/auth.mjs';

const PAIRING = Object.freeze({ serverUrl: 'https://socket.example.test',
  pairingId: 'x'.repeat(32), code: '001234', expiresAt: 2_000_000_000_000 });
const LEGACY = [
  'Pair your app: enter the 6-digit code, then the server URL and temporary pairing key.',
  JSON.stringify(PAIRING, null, 2),
  'One use, valid for 5 minutes. If needed, run abot-socket pair again for fresh details.',
];
const QR_MARKER = '\u001b[30;47mTEST QR\u001b[0m';

function workspace(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'abot-qr-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'installation') };
}

function capture({ isTTY = false, columns = 80, term } = {}) {
  const lines = [], errors = [];
  return { lines, errors, io: { env: term === undefined ? {} : { TERM: term },
    input: { isTTY: false }, output: { isTTY, columns, write: line => lines.push(line) },
    error: line => errors.push(line) } };
}

function emittedPairing(lines) {
  return JSON.parse(lines.find(line => line.startsWith('{')));
}

function assertManualPreserved(lines) {
  for (const line of LEGACY) assert.ok(lines.includes(line), 'Manual pairing output must remain available');
}

test('non-TTY pairing output remains exactly the legacy manual and JSON contract', () => {
  for (const options of [{}, { isTTY: false, columns: 160 }]) {
    const lines = [];
    let renders = 0;
    printPairing(PAIRING, line => lines.push(line), { ...options,
      renderQr: () => { renders += 1; return QR_MARKER; } });
    assert.equal(renders, 0, 'Piped output must not invoke the renderer');
    assert.deepEqual(lines, LEGACY);
    assert.equal(emittedPairing(lines).code, '001234');
  }
});

test('TTY adds one QR from the same pairing while preserving manual output', () => {
  const lines = [], calls = [];
  printPairing(PAIRING, line => lines.push(line), { isTTY: true, columns: 100,
    renderQr: (pairing, options) => { calls.push({ pairing, options }); return QR_MARKER; } });
  assertManualPreserved(lines);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].pairing, PAIRING);
  assert.equal(calls[0].options.columns, 100);
  assert.equal(lines.filter(line => line.includes(QR_MARKER)).length, 1);
});

test('dumb terminal skips QR and narrow terminal falls back to manual fields', () => {
  const dumb = [];
  let renders = 0;
  printPairing(PAIRING, line => dumb.push(line), { isTTY: true, term: 'dumb',
    renderQr: () => { renders += 1; return QR_MARKER; } });
  assert.equal(renders, 0, 'Dumb terminals must not invoke the renderer');
  assert.deepEqual(dumb, LEGACY);
  const narrow = [];
  printPairing(PAIRING, line => narrow.push(line), { isTTY: true, columns: 12 });
  assertManualPreserved(narrow);
  assert.equal(narrow.join('\n').includes('\u001b['), false);
});

test('QR rendering failure preserves the issued bundle and never exposes the exception', () => {
  const lines = [];
  assert.doesNotThrow(() => printPairing(PAIRING, line => lines.push(line), { isTTY: true,
    renderQr: () => { throw new Error('PRIVATE_RENDERER_DETAIL'); } }));
  assertManualPreserved(lines);
  assert.equal(lines.join('\n').includes('PRIVATE_RENDERER_DETAIL'), false);
});

test('installation output forwards terminal options to the shared pairing renderer', () => {
  const lines = [];
  printInstallation({ directory: '/private/test-install', configPath: '/private/test-install/config.json',
    pairing: PAIRING }, line => lines.push(line), { isTTY: true, columns: 90,
    renderQr: (_pairing, options) => { assert.equal(options.columns, 90); return QR_MARKER; } });
  assertManualPreserved(lines);
  assert.ok(lines.some(line => line.includes(QR_MARKER)));
});

test('real pair entry forwards TTY, column and TERM behavior without changing non-TTY JSON', async t => {
  const { root, output } = workspace(t);
  const installation = createInstallation({ output, origin: PAIRING.serverUrl, runtimeId: 'test-runtime' });
  const runtimeToken = JSON.parse(readFileSync(installation.runtimeConnectionPath, 'utf8')).runtimeToken;
  for (const options of [{ isTTY: true, columns: 160 }, { isTTY: false, columns: 160 },
    { isTTY: true, columns: 12 }, { isTTY: true, columns: 160, term: 'dumb' }]) {
    const h = capture(options);
    assert.equal(await runEntry(['pair', '--config', installation.configPath], { ...h.io, homeDirectory: root }), 0);
    assert.deepEqual(h.errors, []);
    const pairing = emittedPairing(h.lines);
    assert.equal(pairing.serverUrl, PAIRING.serverUrl);
    assert.match(pairing.code, /^\d{6}$/);
    assert.match(pairing.pairingId, /^[A-Za-z0-9_-]{32}$/);
    const text = h.lines.join('');
    assert.equal(text.includes('\u001b['), options.isTTY && options.columns === 160 && options.term !== 'dumb');
    assert.equal(text.includes(runtimeToken), false);
    if (!options.isTTY) assert.equal(h.lines.length, 3);
  }
});

test('explicit setup entry forwards TTY settings and keeps runtime credentials private', async t => {
  const { root, output } = workspace(t);
  const h = capture({ isTTY: true, columns: 160 });
  assert.equal(await runEntry(['setup', '--output', output, '--origin', PAIRING.serverUrl,
    '--runtime-id', 'test-runtime'], { ...h.io, homeDirectory: root }), 0);
  assert.deepEqual(h.errors, []);
  assert.ok(h.lines.join('').includes('\u001b['));
  const token = JSON.parse(readFileSync(join(output, 'runtime-connection.json'), 'utf8')).runtimeToken;
  assert.equal(h.lines.join('').includes(token), false);
});

test('pair renderer failure still succeeds with the same redeemable one-time bundle', t => {
  const { output } = workspace(t);
  const installation = createInstallation({ output, origin: PAIRING.serverUrl, runtimeId: 'test-runtime' });
  const lines = [], errors = [];
  let renders = 0;
  assert.equal(runCli(['pair'], { env: { ABOT_SOCKET_CONFIG: installation.configPath },
    out: line => lines.push(line), error: line => errors.push(line), pairingOutput: { isTTY: true,
      renderQr: () => { renders += 1; throw new Error('PRIVATE_RENDERER_DETAIL'); } } }), 0);
  assert.equal(renders, 1);
  assert.deepEqual(errors, []);
  assert.equal(lines.join('\n').includes('PRIVATE_RENDERER_DETAIL'), false);
  const pairing = emittedPairing(lines);
  const auth = new AuthService({ stateDirectory: join(output, 'state') });
  try {
    const device = auth.redeemPairing({ ...pairing, deviceName: 'Dummy test phone' }, 'fixture');
    assert.ok(auth.authenticate(device.token));
    assert.throws(() => auth.redeemPairing(pairing, 'fixture'));
  } finally { auth.close(); }
});

test('interactive wizard forwards QR output options without another pairing or network check', async t => {
  const { root } = workspace(t);
  const answers = ['', PAIRING.serverUrl, '', '', 'yes', 'no'];
  const lines = [];
  let creations = 0, renders = 0;
  assert.equal(await runSetupWizard({ homeDirectory: root, platform: 'darwin', username: 'dummy',
    nodePath: '/usr/bin/node', entryPath: '/opt/abot/bin/abot-socket.mjs',
    ask: async () => { assert.ok(answers.length); return answers.shift(); },
    out: line => lines.push(line), create: options => {
      creations += 1;
      return { directory: options.output, configPath: join(options.output, 'config.json'), pairing: PAIRING };
    }, checkEndpoint: () => assert.fail('No health/network check was selected'),
    pairingOutput: { isTTY: true, columns: 100, renderQr: (pairing, options) => {
      renders += 1; assert.deepEqual(pairing, PAIRING); assert.equal(options.columns, 100); return QR_MARKER;
    } },
  }), 0);
  assert.equal(creations, 1);
  assert.equal(renders, 1);
  assert.equal(answers.length, 0);
  assert.ok(lines.some(line => line.includes(QR_MARKER)));
});
