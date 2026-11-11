import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { NotificationService } from '../src/notifications/notification-service.mjs';

export function notificationFixture(t, { mode = 'fcm', configured = true, send } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'abot-notifications-')));
  const stateDirectory = join(directory, 'state');
  let time = 1_000_000;
  const now = () => time;
  const database = new AuthDatabase(stateDirectory);
  const auth = new AuthService({ database, now });
  const deliveries = [];
  const changes = [];
  const delivery = { mode, configured, send: send ?? (async (message) => {
    deliveries.push(message); return { status: 'delivered' };
  }) };
  const service = new NotificationService({ database, now, delivery, onChanged: deviceId => changes.push(deviceId) });
  const unsubscribe = auth.subscribeRevocations(id => service.revoke(id));
  t.after(async () => {
    await service.close(); unsubscribe(); auth.close(); database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pair = () => auth.redeemPairing({ ...auth.createPairing(), deviceName: 'Test device' }, 'fixture');
  const identity = (device, requestId = 'request-1') => ({ deviceId: device.session.id,
    runtimeId: 'test-runtime', sessionId: 'test-conversation', requestId });
  return { stateDirectory, database, auth, service, delivery, deliveries, changes, pair, identity, now,
    advance: ms => { time += ms; } };
}
