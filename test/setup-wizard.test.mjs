import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupWizard } from '../src/setup/setup-wizard.mjs';

function harness(t, answers, extra = {}) {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'abot-wizard-'));
  t.after(() => rmSync(homeDirectory, { recursive: true, force: true }));
  const logs = [], prompts = [], effects = [];
  return {
    effects, logs, prompts, homeDirectory,
    options: { homeDirectory, platform: 'darwin', username: 'operator',
      nodePath: '/usr/bin/node', entryPath: '/opt/abot/bin/abot-socket.mjs',
      ask: async (prompt) => { prompts.push(prompt); assert.ok(answers.length, 'Unexpected prompt'); return answers.shift(); },
      out: (line) => logs.push(line),
      create: (options) => {
        effects.push(['create', options]);
        return { directory: options.output, configPath: join(options.output, 'config.json'),
          pairing: { serverUrl: options.origin, pairingId: 'x'.repeat(32), code: '123456', expiresAt: 1_000_000 } };
      },
      render: (options) => { effects.push(['render', options]); return { files: {} }; },
      writePlan: (options) => { effects.push(['plan', options]); },
      checkEndpoint: async (origin) => { effects.push(['health', origin]); return { ok: true, code: 'reachable', runtimeVerified: false }; },
      ...extra,
    },
  };
}

test('wizard cancellation creates no installation, checks, or deployment writes', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'n']);
  assert.equal(await runSetupWizard(h.options), 0);
  assert.deepEqual(h.effects, []);
  assert.equal(existsSync(join(h.homeDirectory, '.abot-socket')), false);
});

test('wizard defaults prepare private configuration without automatic network or services', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'yes', 'no']);
  assert.equal(await runSetupWizard(h.options), 0);
  assert.deepEqual(h.effects.map(([kind]) => kind), ['create']);
  assert.equal(h.effects[0][1].port, 8788);
  assert.equal(h.effects[0][1].runtimeId, 'workstation');
  assert.equal(h.effects[0][1].output, join(h.homeDirectory, '.abot-socket'));
  assert.ok(h.logs.some((line) => line.includes('not started')));
  assert.ok(h.logs.some((line) => line.includes('123456')));
});

test('invalid origin, runtime and port are corrected before creation', async (t) => {
  const h = harness(t, ['', 'http://bad.example', 'https://socket.example.test', 'bad id', 'workstation', '80', '9010', 'y', 'n']);
  await runSetupWizard(h.options);
  assert.equal(h.effects[0][1].port, 9010);
  assert.equal(h.logs.filter((line) => line.startsWith('Invalid ')).length, 3);
});

test('Linux plan is validated before confirmation and written only after explicit acceptance', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'nginx', '/etc/ssl/server.crt', '/etc/ssl/server.key', 'y', 'n'], { platform: 'linux' });
  await runSetupWizard(h.options);
  assert.deepEqual(h.effects.map(([kind]) => kind), ['render', 'create', 'plan']);
  assert.equal(h.effects[0][1].proxy, 'nginx');
  assert.equal(h.effects[0][1].certificatePath, '/etc/ssl/server.crt');
});

test('cancelled Linux plan is not applied or written', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'none', 'n'], { platform: 'linux' });
  await runSetupWizard(h.options);
  assert.deepEqual(h.effects.map(([kind]) => kind), ['render']);
});

test('unsafe plan fails before private setup writes', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'none'], {
    platform: 'linux', render: () => { throw new Error('Unsafe service path'); },
  });
  await assert.rejects(runSetupWizard(h.options), /Unsafe service path/);
  assert.deepEqual(h.effects, []);
});

test('public connectivity check is opt-in and never claims runtime readiness', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'y', 'y']);
  assert.equal(await runSetupWizard(h.options), 0);
  assert.deepEqual(h.effects.map(([kind]) => kind), ['create', 'health']);
  assert.ok(h.logs.some((line) => line.includes('not tested by this health check')));
});

test('a failed health check does not repeat setup or issue another pairing', async (t) => {
  const h = harness(t, ['', 'https://socket.example.test', '', '', 'y', 'y'], {
    checkEndpoint: async () => ({ ok: false, code: 'timeout', runtimeVerified: false }),
  });
  assert.equal(await runSetupWizard(h.options), 1);
  assert.deepEqual(h.effects.map(([kind]) => kind), ['create']);
});

test('closing input before confirmation leaves nothing behind', async (t) => {
  const h = harness(t, [], { ask: async () => { throw new Error('Input closed'); } });
  await assert.rejects(runSetupWizard(h.options), /Input closed/);
  assert.deepEqual(h.effects, []);
});
