import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNotificationGatewayConfiguration, startConfiguredNotificationGateway } from '../src/notifications/notification-gateway-command.mjs';

test('gateway configuration is separate from chat credentials and resolves private paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abot-gateway-config-'));
  const path = join(root, 'gateway.json');
  const config = { publicOrigin: 'https://push.example.invalid', stateDirectory: './state', serviceAccountFile: './service.json' };
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(loadNotificationGatewayConfiguration(path), { ...config, port: 8790,
      stateDirectory: join(root, 'state'), serviceAccountFile: join(root, 'service.json') });
    let listened;
    let closed = false;
    const gateway = await startConfiguredNotificationGateway({ ABOT_SOCKET_CONFIG: path }, {
      createProvider: ({ serviceAccountFile }) => {
        assert.equal(serviceAccountFile, join(root, 'service.json'));
        return { sendEnvelope: async () => ({ status: 'delivered' }) };
      },
      createGateway: (options) => {
        assert.equal(options.publicOrigin, config.publicOrigin);
        return { listen: async (port) => { listened = port; }, close: async () => { closed = true; } };
      },
    });
    assert.equal(listened, 8790);
    await gateway.close(); assert.equal(closed, true);
    for (const invalid of [
      { ...config, publicOrigin: 'http://push.example.invalid' },
      { ...config, runtimeGrants: [] },
      { ...config, port: 443 },
      { ...config, serviceAccountFile: '' },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => loadNotificationGatewayConfiguration(path));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
