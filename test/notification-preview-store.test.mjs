import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { NotificationService } from '../src/notifications/notification-service.mjs';
import { notificationFixture } from './notification-fixture.mjs';
import { previewKey, openPreview, queuedPreview } from './notification-preview-fixture.mjs';

function enabled(f, device = f.pair()) {
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-preview-device-token' });
  f.service.enablePreview(device.session.id, previewKey);
  return device;
}
const complete = (f, device, id = 'request-preview', text = 'שלום private final answer') =>
  f.service.observe(f.identity(device, id), { type: 'completed', output: text });

test('previews default off, require registration, stay origin-device scoped and never enter inbox or plaintext storage', t => {
  const f = notificationFixture(t); const device = f.pair(); const other = f.pair();
  assert.deepEqual(f.service.list(device.session.id).preview, { supported: true, enabled: false, keyId: null });
  assert.throws(() => f.service.enablePreview(device.session.id, previewKey), { code: 'push_unavailable' });
  enabled(f, device); complete(f, device);
  const queued = queuedPreview(f.database);
  assert.equal(openPreview(queued.preview, queued.id), 'שלום private final answer');
  const list = JSON.stringify(f.service.list(device.session.id));
  for (const secret of ['private final answer', previewKey.key, queued.preview.ciphertext]) assert.equal(list.includes(secret), false);
  assert.deepEqual(f.service.list(other.session.id).preview, { supported: true, enabled: false, keyId: null });
  assert.equal(f.service.list(other.session.id).items.length, 0);
  assert.equal(f.database.prepare('SELECT encrypted_preview FROM notification_outbox').get().encrypted_preview.includes('private final answer'), false);
  assert.equal(f.database.prepare('PRAGMA table_info(notifications)').all().some(row => /text|preview|output/.test(row.name)), false);
});

test('only completed final output is encrypted; missing output and other events remain generic', t => {
  const f = notificationFixture(t); const device = enabled(f);
  f.service.observe(f.identity(device, 'failed'), { type: 'failed', error: 'private error', output: 'not a final response' });
  f.service.observe(f.identity(device, 'approval'), { type: 'event', name: 'tool.approval.required', approvalId: 'approval-1', output: 'private prompt' });
  complete(f, device, 'empty', '');
  f.service.observe(f.identity(device, 'progress'), { type: 'event', name: 'user.interaction', output: 'private progress' });
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM notification_outbox WHERE encrypted_preview IS NOT NULL').get().count, 0);
  assert.equal(f.service.list(device.session.id).items.length, 3);
});

test('ciphertext survives restart/retry and uses device-capped expiry, then disappears after delivery', async t => {
  const f = notificationFixture(t, { send: async () => ({ status: 'retry' }) }); const device = enabled(f);
  f.database.prepare('UPDATE devices SET expires_at = ? WHERE id = ?').run(f.now() + 60_000, device.session.id);
  complete(f, device); const queued = queuedPreview(f.database);
  assert.equal(queued.preview.expiresAt, f.now() + 60_000);
  await f.service.tick(); assert.deepEqual(queuedPreview(f.database), queued);
  await f.service.close(); f.advance(30_000);
  const delivered = [];
  const reopened = new NotificationService({ database: f.database, now: f.now,
    delivery: { mode: 'fcm', configured: true, send: async message => { delivered.push(message); return { status: 'delivered' }; } } });
  try {
    await reopened.tick();
    assert.equal(openPreview(delivered[0].notification.preview, queued.id), 'שלום private final answer');
    assert.equal(queuedPreview(f.database), null);
  } finally { await reopened.close(); }
});

test('preview disable and key replacement clear ciphertext but keep generic queue; provider rotation preserves key', async t => {
  const f = notificationFixture(t); const device = enabled(f); complete(f, device);
  f.service.register(device.session.id, { provider: 'fcm', token: 'rotated-device-token' });
  assert.equal(f.service.list(device.session.id).preview.enabled, true);
  assert.ok(queuedPreview(f.database).preview);
  f.service.disablePreview(device.session.id);
  assert.equal(queuedPreview(f.database).preview, null);
  assert.equal(f.service.list(device.session.id).registration.enabled, true);
  assert.equal(f.service.list(device.session.id).preview.enabled, false);
  f.service.enablePreview(device.session.id, previewKey);
  assert.equal(queuedPreview(f.database).preview, null, 'enabling cannot recreate old plaintext');
  complete(f, device, 'new');
  f.service.enablePreview(device.session.id, { keyId: Buffer.alloc(16, 9).toString('base64url'), key: Buffer.alloc(32, 9).toString('base64url') });
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE encrypted_preview IS NOT NULL').get().n, 0);
  await f.service.tick(); assert.equal(f.deliveries.length, 2);
  assert.ok(f.deliveries.every(item => item.notification.preview === undefined));
});

test('read, push unregister, device revoke and expiry remove queued ciphertext and unused keys', async t => {
  for (const operation of ['read', 'unregister', 'revoke', 'expiry']) {
    const f = notificationFixture(t); const device = enabled(f); complete(f, device);
    const queued = queuedPreview(f.database);
    if (operation === 'read') f.service.markRead(device.session.id, [queued.id]);
    if (operation === 'unregister') f.service.unregister(device.session.id);
    if (operation === 'revoke') f.auth.revokeDevice(device.session.id);
    if (operation === 'expiry') { f.advance(31 * 86_400_000); f.service.store.prune(); }
    assert.equal(queuedPreview(f.database), null);
    if (operation !== 'read') assert.equal(f.service.store.previews.status(device.session.id).enabled, false);
  }
});

test('disable while delivery is in flight aborts ciphertext and retries only generic without invalidating registration', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = notificationFixture(t, { send: (message, signal) => new Promise(resolve => {
    assert.ok(message.notification.preview); started();
    signal.addEventListener('abort', () => resolve({ status: 'invalid' }), { once: true });
  }) });
  const device = enabled(f); complete(f, device);
  const sending = f.service.tick(); await ready; f.service.disablePreview(device.session.id); await sending;
  assert.equal(queuedPreview(f.database).preview, null);
  assert.equal(f.service.list(device.session.id).registration.enabled, true);
  f.advance(30_000); let next;
  f.delivery.send = async message => { next = message; return { status: 'delivered' }; };
  await f.service.tick(); assert.equal(next.notification.preview, undefined);
});

test('v2 migration preserves pairing, tokens and generic outbox; preview defaults off', async t => {
  const f = notificationFixture(t); const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-old-token' }); complete(f, device);
  const pending = f.auth.createPairing(); const owner = f.database.ownerId;
  await f.service.close();
  f.database.prepare('DROP TABLE notification_preview_keys').run();
  f.database.prepare('ALTER TABLE notification_outbox DROP COLUMN encrypted_preview').run();
  f.database.prepare('PRAGMA user_version = 2').run();
  const migrated = new AuthDatabase(f.stateDirectory); const auth = new AuthService({ database: migrated, now: f.now });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(migrated.ownerId, owner);
    assert.equal(auth.authenticate(device.token).sessionId, device.session.id);
    assert.ok(auth.redeemPairing(pending, 'fixture').token);
    assert.equal(migrated.prepare('SELECT encrypted_preview FROM notification_outbox').get().encrypted_preview, null);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM notification_preview_keys').get().n, 0);
  } finally { auth.close(); migrated.close(); }
});


test('final-attempt preview disable or provider rotation retains the existing delivery until a later valid send', async t => {
  for (const operation of ['disable', 'rotate']) {
    let started; const ready = new Promise(resolve => { started = resolve; });
    const f = notificationFixture(t, { send: (_message, signal) => new Promise(resolve => {
      started(); signal.addEventListener('abort', () => resolve({ status: 'retry' }), { once: true });
    }) });
    const device = enabled(f); complete(f, device);
    f.database.prepare('UPDATE notification_outbox SET attempts = 4').run();
    const sending = f.service.tick(); await ready;
    if (operation === 'disable') f.service.disablePreview(device.session.id);
    else f.service.register(device.session.id, { provider: 'fcm', token: 'rotated-on-final-attempt' });
    await sending;
    assert.equal(f.database.prepare('SELECT attempts FROM notification_outbox').get().attempts, 4);
    let delivered; f.delivery.send = async message => { delivered = message; return { status: 'delivered' }; };
    f.advance(30_000); await f.service.tick();
    assert.ok(delivered);
    assert.equal(Boolean(delivered.notification.preview), operation === 'rotate');
    assert.equal(queuedPreview(f.database), null);
  }
});
