import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliInvocation } from '../src/cli/cli-environment.mjs';
import { runEntry } from '../src/cli/cli-entry.mjs';
import { parseDeploymentArguments } from '../src/deployment/deployment-command.mjs';

const home = '/home/test-operator';

test('CLI defaults to its own private installation and preserves environment aliases', () => {
  assert.equal(resolveCliInvocation(['pair'], {}, home).env.ABOT_SOCKET_CONFIG, `${home}/.abot-socket/config.json`);
  assert.deepEqual(resolveCliInvocation(['pair'], { SOCKET_V2_CONFIG: '/srv/socket/config.json' }, home).env,
    { SOCKET_V2_CONFIG: '/srv/socket/config.json' });
  const env = { ABOT_SOCKET_CONFIG: '/srv/a.json', SOCKET_V2_CONFIG: '/srv/b.json' };
  const explicit = resolveCliInvocation(['pair', '--config', '/srv/c.json'], env, home);
  assert.equal(explicit.env.ABOT_SOCKET_CONFIG, '/srv/c.json');
  assert.equal(explicit.env.SOCKET_V2_CONFIG, undefined);
  assert.deepEqual(env, { ABOT_SOCKET_CONFIG: '/srv/a.json', SOCKET_V2_CONFIG: '/srv/b.json' });
  assert.equal(explicit.command, 'pair'); assert.deepEqual(explicit.args, []);
});

test('global config selector rejects missing, duplicate and setup-conflicting inputs', () => {
  for (const args of [['pair', '--config'], ['pair', '--config', '--help'],
    ['--config', '/a', 'pair', '--config', '/b'], ['setup', '--config', '/a']]) {
    assert.throws(() => resolveCliInvocation(args, {}, home));
  }
});

test('real dispatch help/version have no configuration or network prerequisite', async () => {
  const lines = [], errors = [];
  const io = { env: {}, homeDirectory: home, output: { write: (line) => lines.push(line) }, error: (line) => errors.push(line) };
  assert.equal(await runEntry(['--help'], io), 0);
  assert.ok(lines.join('').includes('abot-socket doctor'));
  lines.length = 0;
  assert.equal(await runEntry(['--version'], io), 0);
  assert.match(lines.join(''), /^ABot Socket \d+\.\d+\.\d+/);
  assert.deepEqual(errors, []);
});

test('non-interactive setup without flags fails promptly rather than waiting for input', async () => {
  const lines = [];
  const code = await runEntry(['setup'], { env: {}, homeDirectory: home, input: { isTTY: false },
    output: { isTTY: false, write: (line) => lines.push(line) } });
  assert.equal(code, 2);
  assert.ok(lines.join('').includes('setup --output'));
});

test('deployment argument parsing never accepts arbitrary command or duplicate options', () => {
  const result = parseDeploymentArguments(['--output', '/srv/plan', '--proxy', 'none']);
  assert.equal(result.output, '/srv/plan'); assert.equal(result.proxy, 'none');
  for (const args of [[], ['--output'], ['--output', '/srv/a', '--output', '/srv/b'], ['--exec', 'sh']]) {
    assert.throws(() => parseDeploymentArguments(args));
  }
});
