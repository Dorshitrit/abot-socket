import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { NotificationService } from '../src/notifications/notification-service.mjs';
import { notificationFixture } from './notification-fixture.mjs';
import { agentNotificationEvent } from './agent-notification-fixture.mjs';
import { restoreLegacyNotificationSchema } from './notification-legacy-schema-fixture.mjs';
import { previewKey, openPreview, queuedPreview } from './notification-preview-fixture.mjs';

const inbox = (service, device) => service.list(device.session.id, { includeAgents: true });
const capable = (f, device = f.pair()) => {
  f.service.setCapabilities(device.session.id, true);
  f.service.register(device.session.id, { provider: 'fcm', token: `fixture-${device.session.id}` });
  return device;
};

test('only capable paired devices get Agent push, while legacy session wire stays unchanged', async t => {
  const f = notificationFixture(t); const phone = capable(f); const second = capable(f); const legacy = f.pair();
  f.service.register(legacy.session.id, { provider: 'fcm', token: 'legacy-apple-token' });
  assert.equal(f.service.observeAgent('test-runtime', agentNotificationEvent(f.now())), true);
  for (const device of [phone, second]) {
    const snapshot = inbox(f.service, device);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.unreadByAgent['test-runtime'].researcher, 1);
    assert.deepEqual(Object.keys(snapshot.unreadBySession), []);
    const [item] = snapshot.items;
    assert.equal(item.target, 'agent'); assert.equal(item.agentId, 'researcher');
    assert.equal(item.messageId, 'reply:message-1'); assert.equal(item.reason, 'reply');
    assert.equal('sessionId' in item, false); assert.equal('requestId' in item, false);
    assert.equal(f.service.list(device.session.id).items.length, 0);
    assert.equal(f.service.list(device.session.id).unreadCount, 0);
    assert.equal('unreadByAgent' in f.service.list(device.session.id), false);
  }
  assert.equal(inbox(f.service, legacy).items.length, 0);
  await f.service.tick();
  assert.equal(f.deliveries.length, 2);
  assert.ok(f.deliveries.every(item => item.registration.token !== 'legacy-apple-token'));
  f.service.observe(f.identity(legacy), { type: 'completed' });
  const [session] = f.service.list(legacy.session.id).items;
  assert.equal(session.sessionId, 'test-conversation'); assert.equal('target' in session, false);
  await f.service.tick(); assert.equal(f.deliveries.length, 3);
});

test('receipt replay survives reopen and cannot notify a newly paired device or recreate a read item', async t => {
  const f = notificationFixture(t); const phone = capable(f);
  const event = agentNotificationEvent(f.now());
  assert.equal(f.service.observeAgent('test-runtime', event), true);
  const [item] = inbox(f.service, phone).items;
  f.service.markRead(phone.session.id, [item.id]);
  f.advance(10); const newcomer = capable(f);
  await f.service.close();
  const database = new AuthDatabase(f.stateDirectory);
  const reopened = new NotificationService({ database, now: f.now, delivery: f.delivery });
  try {
    assert.equal(reopened.observeAgent('test-runtime', event), true);
    assert.equal(inbox(reopened, phone).items[0].id, item.id);
    assert.equal(inbox(reopened, phone).unreadCount, 0);
    assert.equal(inbox(reopened, newcomer).items.length, 0);
    assert.equal(reopened.observeAgent('test-runtime', { ...event, output: 'Changed same event' }), false);
    await reopened.tick(); assert.equal(f.deliveries.length, 0);
  } finally { await reopened.close(); database.close(); }
});

test('capability opt-in is idempotent, excludes earlier events, and false cancels queued Agent delivery only', async t => {
  const f = notificationFixture(t); const phone = capable(f); const createdAt = f.now();
  f.advance(20); f.service.setCapabilities(phone.session.id, true);
  assert.equal(f.service.observeAgent('test-runtime', agentNotificationEvent(createdAt)), true);
  assert.equal(inbox(f.service, phone).items.length, 1);
  f.service.observe(f.identity(phone), { type: 'completed' });
  f.service.setCapabilities(phone.session.id, false);
  await f.service.tick();
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].notification.target, undefined);
  f.advance(20); f.service.setCapabilities(phone.session.id, true);
  f.service.observeAgent('test-runtime', agentNotificationEvent(createdAt, { messageId: 'older-new-id' }));
  assert.equal(inbox(f.service, phone).items.length, 2); // prior Agent + ordinary session only
});

test('unknown outcome attention has no fake message and does not become a tool approval', t => {
  const f = notificationFixture(t); const phone = capable(f);
  const event = agentNotificationEvent(f.now(), { reason: 'attention', messageId: undefined, output: '' });
  assert.equal(f.service.observeAgent('test-runtime', event), true);
  const [item] = inbox(f.service, phone).items;
  assert.equal(item.reason, 'attention'); assert.equal(item.kind, 'failed');
  assert.equal('messageId' in item, false);
});

test('atomic recipient fan-out leaves no receipt or partial notification on storage failure', t => {
  const f = notificationFixture(t); const phone = capable(f); const other = capable(f);
  const original = f.service.store.recordInTransaction.bind(f.service.store);
  let calls = 0;
  f.service.store.recordInTransaction = (...args) => {
    if (++calls === 2) throw new Error('fixture storage failure');
    return original(...args);
  };
  const event = agentNotificationEvent(f.now());
  assert.throws(() => f.service.observeAgent('test-runtime', event), /fixture storage failure/);
  assert.equal(inbox(f.service, phone).items.length, 0); assert.equal(inbox(f.service, other).items.length, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM agent_notification_receipts').get().n, 0);
  f.service.store.recordInTransaction = original;
  assert.equal(f.service.observeAgent('test-runtime', event), true);
  assert.equal(inbox(f.service, phone).items.length, 1); assert.equal(inbox(f.service, other).items.length, 1);
});

test('revocation and expired events do not deliver; receipt pressure remains bounded', async t => {
  const f = notificationFixture(t); const phone = capable(f);
  const event = agentNotificationEvent(f.now());
  f.auth.revokeDevice(phone.session.id);
  assert.equal(f.service.observeAgent('test-runtime', event), true);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  f.advance(7 * 86_400_000 + 1);
  assert.equal(f.service.observeAgent('test-runtime', event), true);
  const insert = f.database.prepare('INSERT INTO agent_notification_receipts VALUES (?, ?, ?, ?)');
  f.database.transaction(() => {
    for (let i = 0; i < 10_000; i++) insert.run('full-runtime', `fixture-${i}`, 'digest', f.now() + 1000);
  });
  assert.equal(f.service.observeAgent('full-runtime', agentNotificationEvent(f.now())), false);
  f.advance(1001);
  assert.equal(f.service.observeAgent('full-runtime', agentNotificationEvent(f.now())), true);
  await f.service.tick(); assert.equal(f.deliveries.length, 0);
});

test('Agent public replies reuse encrypted preview and never store plaintext', async t => {
  const f = notificationFixture(t); const phone = capable(f);
  f.service.enablePreview(phone.session.id, previewKey);
  const text = 'שלום, המחקר הסתיים.';
  f.service.observeAgent('test-runtime', agentNotificationEvent(f.now(), { output: text }));
  const queued = queuedPreview(f.database);
  assert.equal(openPreview(queued.preview, queued.id), text);
  assert.equal(JSON.stringify(inbox(f.service, phone)).includes(text), false);
  assert.equal(JSON.stringify(f.database.prepare('SELECT * FROM agent_notification_receipts').all()).includes(text), false);
  await f.service.tick(); assert.equal(f.deliveries.length, 1);
  assert.equal(openPreview(f.deliveries[0].notification.preview, queued.id), text);
});

test('v4 migration preserves pairing, tokens, existing notification identity and pending encrypted delivery', async t => {
  const f = notificationFixture(t); const phone = f.pair();
  f.service.register(phone.session.id, { provider: 'fcm', token: 'existing-apple-registration' });
  f.service.enablePreview(phone.session.id, previewKey);
  f.service.observe(f.identity(phone), { type: 'completed', output: 'existing final reply' });
  const pending = f.auth.createPairing(); const queued = queuedPreview(f.database);
  const owner = f.database.ownerId; const salt = f.database.tokenSalt;
  f.database.prepare('UPDATE notification_outbox SET attempts = 2, next_at = ?').run(f.now() + 30_000);
  await f.service.close();
  restoreLegacyNotificationSchema(f.database);
  f.database.prepare('PRAGMA user_version = 4').run();
  const database = new AuthDatabase(f.stateDirectory);
  const auth = new AuthService({ database, now: f.now });
  const service = new NotificationService({ database, now: f.now, delivery: f.delivery });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(database.ownerId, owner); assert.equal(database.tokenSalt, salt);
    assert.equal(auth.authenticate(phone.token).sessionId, phone.session.id);
    assert.ok(auth.redeemPairing(pending, 'migration').token);
    assert.deepEqual(queuedPreview(database), queued);
    assert.equal(database.prepare('SELECT attempts FROM notification_outbox').get().attempts, 2);
    assert.equal(service.store.registration(phone.session.id).token, 'existing-apple-registration');
    assert.equal(service.agents.supportsAgents(phone.session.id), false);
    assert.equal(service.list(phone.session.id).items[0].id, queued.id);
    f.advance(30_000); await service.tick();
    assert.equal(f.deliveries.length, 1);
    assert.equal(openPreview(f.deliveries[0].notification.preview, queued.id), 'existing final reply');
  } finally { await service.close(); auth.close(); database.close(); }
});
