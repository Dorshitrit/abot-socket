import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { NotificationService } from '../src/notifications/notification-service.mjs';
import { notificationListOptions, notificationPresence, notificationReadIds, notificationRegistration } from '../src/notifications/notification-input.mjs';
import { notificationFixture } from './notification-fixture.mjs';

test('inbox is origin-device scoped, metadata-only, deduplicated and isolated on read', t => {
  const f = notificationFixture(t);
  const first = f.pair(); const second = f.pair();
  f.service.observe(f.identity(first), { type: 'completed', output: 'PRIVATE CHAT CONTENT' });
  f.service.observe(f.identity(first), { type: 'completed', output: 'duplicate' });
  const result = f.service.list(first.session.id);
  assert.equal(result.version, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'completed');
  assert.equal(result.unreadCount, 1);
  assert.equal(result.unreadByRuntime['test-runtime'], 1);
  assert.equal(result.unreadBySession['test-runtime']['test-conversation'], 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(f.service.list(second.session.id).unreadCount, 0);
  f.service.markRead(second.session.id, [result.items[0].id]);
  assert.equal(f.service.list(first.session.id).unreadCount, 1);
  f.service.markRead(first.session.id, [result.items[0].id]);
  assert.equal(f.service.list(first.session.id).unreadCount, 0);
});

test('presence is advisory; a paused phone without a read acknowledgement still receives the notification', async t => {
  const f = notificationFixture(t); const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-token' });
  f.service.updatePresence(device.session.id, { foreground: true, runtimeId: 'test-runtime', sessionId: 'test-conversation' });
  f.service.observe(f.identity(device), { type: 'completed' });
  await f.service.tick();
  assert.equal(f.service.list(device.session.id).items.length, 1);
  assert.equal(f.service.list(device.session.id).unreadCount, 1);
  assert.equal(f.deliveries.length, 1);
  f.service.updatePresence(device.session.id, { foreground: true, runtimeId: 'test-runtime', sessionId: 'elsewhere' });
  f.service.observe(f.identity(device, 'request-2'), { type: 'failed', error: 'PRIVATE' });
  await f.service.tick();
  assert.equal(f.deliveries.length, 2);
  f.service.updatePresence(device.session.id, { foreground: true, runtimeId: 'test-runtime', sessionId: 'test-conversation' });
  f.advance(45_001);
  f.service.observe(f.identity(device, 'request-3'), { type: 'completed' });
  await f.service.tick();
  assert.equal(f.deliveries.length, 3);
});

test('explicit read acknowledgement cancels queued delivery before provider submission', async t => {
  const f = notificationFixture(t); const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-token' });
  f.service.observe(f.identity(device), { type: 'completed' });
  const [item] = f.service.list(device.session.id).items;
  f.service.markRead(device.session.id, [item.id]);
  await f.service.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.service.list(device.session.id).unreadCount, 0);
});

test('observed approval expires after five minutes and resolved approval cancels queued delivery', async t => {
  const f = notificationFixture(t); const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-token' });
  const identity = f.identity(device);
  f.service.observe(identity, { type: 'event', name: 'tool.approval.required', approvalId: 'approval-1' });
  assert.equal(f.service.list(device.session.id).items[0].expiresAt, f.now() + 300_000);
  f.service.observe(identity, { type: 'event', name: 'tool.approval.granted', approvalId: 'approval-1' });
  await f.service.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.service.list(device.session.id).unreadCount, 0);
  f.service.observe(f.identity(device, 'request-2'), { type: 'event', name: 'tool.approval.required', approvalId: 'approval-2' });
  f.advance(300_001);
  await f.service.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.service.list(device.session.id).items.length, 0);
});

test('revocation and credential expiry remove inbox, registration and pending delivery', async t => {
  const f = notificationFixture(t); const first = f.pair(); const second = f.pair();
  for (const device of [first, second]) {
    f.service.register(device.session.id, { provider: 'fcm', token: `dummy-${device.session.id}` });
    f.service.observe(f.identity(device), { type: 'completed' });
  }
  f.auth.revokeDevice(first.session.id);
  assert.equal(f.service.list(first.session.id).items.length, 0);
  assert.equal(f.service.store.registration(first.session.id), null);
  f.advance(30 * 24 * 60 * 60 * 1000 + 1);
  f.auth.prune();
  await f.service.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.service.store.registration(second.session.id), null);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get().count, 0);
});

test('durable outbox resumes after process ownership is replaced without re-running requests', async t => {
  const f = notificationFixture(t); const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-token' });
  f.service.observe(f.identity(device), { type: 'completed' });
  await f.service.close();
  const database = new AuthDatabase(f.stateDirectory);
  const reopened = new NotificationService({ database, now: f.now, delivery: f.delivery });
  try {
    assert.equal(reopened.list(device.session.id).unreadCount, 1);
    await reopened.tick(); await reopened.tick();
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].notification.kind, 'completed');
  } finally { await reopened.close(); database.close(); }
});

test('outbox retries are bounded and invalid tokens remove only the matching registration', async t => {
  let calls = 0;
  const f = notificationFixture(t, { send: async () => { calls += 1; return { status: 'retry' }; } });
  const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'dummy-token' });
  f.service.observe(f.identity(device), { type: 'completed' });
  for (let attempt = 0; attempt < 8; attempt += 1) { await f.service.tick(); f.advance(600_001); }
  assert.equal(calls, 5);
  assert.equal(f.service.list(device.session.id).unreadCount, 1);
  f.service.delivery.send = async () => ({ status: 'invalid' });
  f.service.observe(f.identity(device, 'request-invalid'), { type: 'completed' });
  await f.service.tick();
  assert.equal(f.service.store.registration(device.session.id), null);
  assert.equal(f.service.list(device.session.id).unreadCount, 2);
});

test('disabled delivery keeps the inbox usable and refuses registrations without sender configuration', async t => {
  const f = notificationFixture(t, { mode: 'disabled', configured: false }); const device = f.pair();
  assert.throws(() => f.service.register(device.session.id, { provider: 'fcm', token: 'dummy' }), { code: 'push_unavailable' });
  f.service.observe(f.identity(device), { type: 'completed' });
  await f.service.tick();
  assert.equal(f.service.list(device.session.id).unreadCount, 1);
  assert.equal(f.service.list(device.session.id).registration.enabled, false);
  assert.equal(f.deliveries.length, 0);
});

test('discarding an invalid or expired message keeps its valid recipient registration for later events', async t => {
  let calls = 0;
  const f = notificationFixture(t, { send: async () => {
    calls += 1; return { status: calls === 1 ? 'discarded' : 'delivered' };
  } });
  const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'valid-token' });
  f.service.observe(f.identity(device), { type: 'completed' });
  await f.service.tick();
  f.advance(600_001); await f.service.tick();
  assert.equal(calls, 1);
  assert.equal(f.service.store.registration(device.session.id).token, 'valid-token');
  assert.equal(f.service.list(device.session.id).registration.enabled, true);
  f.service.observe(f.identity(device, 'next-request'), { type: 'completed' });
  await f.service.tick();
  assert.equal(calls, 2);
  assert.equal(f.service.store.registration(device.session.id).token, 'valid-token');
});

test('read, revoke and shutdown abort in-flight delivery; token rotation preserves its replacement', async t => {
  const signals = [];
  let finish;
  const f = notificationFixture(t, { send: async (_message, signal) => {
    signals.push(signal);
    return new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve({ status: 'invalid' }), { once: true }); });
  } });
  const device = f.pair();
  f.service.register(device.session.id, { provider: 'fcm', token: 'old-token' });
  f.service.observe(f.identity(device), { type: 'completed' });
  const running = f.service.tick();
  assert.equal(signals.length, 1);
  f.service.register(device.session.id, { provider: 'fcm', token: 'replacement-token' });
  await running;
  assert.equal(signals[0].aborted, true);
  assert.equal(f.service.store.registration(device.session.id).token, 'replacement-token');
  f.service.observe(f.identity(device, 'request-read'), { type: 'completed' });
  const reading = f.service.tick();
  const item = f.service.list(device.session.id).items.find(value => value.requestId === 'request-read');
  f.service.markRead(device.session.id, [item.id]); await reading;
  assert.equal(signals[1].aborted, true);
  assert.equal(f.service.store.registration(device.session.id).token, 'replacement-token');
  f.service.observe(f.identity(device, 'request-revoke'), { type: 'completed' });
  const revoking = f.service.tick(); f.auth.revokeDevice(device.session.id); await revoking;
  assert.equal(signals[2].aborted, true);
  const last = f.pair(); f.service.register(last.session.id, { provider: 'fcm', token: 'final-token' });
  f.service.observe(f.identity(last), { type: 'completed' });
  const closing = f.service.tick(); await f.service.close(); await closing;
  assert.equal(signals[3].aborted, true);
  assert.equal(typeof finish, 'function');
});

test('pagination is stable at identical timestamps; retention and per-device storage are bounded', t => {
  const f = notificationFixture(t); const device = f.pair();
  for (let index = 0; index < 505; index += 1) f.service.observe(f.identity(device, `request-${index}`), { type: 'completed' });
  const first = f.service.list(device.session.id, { limit: 100 });
  assert.equal(first.unreadCount, 500);
  const next = f.service.list(device.session.id, notificationListOptions(new URLSearchParams({ limit: '100', before: first.nextCursor })));
  assert.equal(next.items.length, 100);
  assert.equal(next.items.some(item => first.items.some(previous => previous.id === item.id)), false);
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  assert.equal(f.service.list(device.session.id).unreadCount, 0);
});

test('strict inputs reject provider endpoints, injected credentials, cross-runtime presence and oversized reads', () => {
  assert.throws(() => notificationRegistration({ provider: 'gateway', endpointId: 'test', sendToken: 'test', url: 'https://attacker.invalid' }));
  assert.throws(() => notificationRegistration({ provider: 'fcm', token: 'dummy', privateKey: 'not-accepted' }));
  assert.throws(() => notificationReadIds({ ids: Array(101).fill('id') }));
  assert.throws(() => notificationPresence({ foreground: true, runtimeId: 'other' }, ['allowed']), { code: 'forbidden' });
  for (const query of ['limit=0', 'limit=101', 'limit=2&limit=3', 'before=invalid', 'owner=other']) {
    assert.throws(() => notificationListOptions(new URLSearchParams(query)));
  }
});

test('schema v1 migrates without losing device tokens, owner identity or pending pairing', async t => {
  const f = notificationFixture(t); const device = f.pair(); const pending = f.auth.createPairing();
  const owner = f.database.ownerId; const salt = f.database.tokenSalt;
  await f.service.close();
  for (const table of ['request_ownership', 'notification_preview_keys', 'notification_outbox', 'notification_registrations', 'notifications']) {
    f.database.prepare(`DROP TABLE ${table}`).run();
  }
  f.database.prepare('PRAGMA user_version = 1').run();
  const migrated = new AuthDatabase(f.stateDirectory);
  const auth = new AuthService({ database: migrated, now: f.now });
  try {
    assert.equal(migrated.ownerId, owner); assert.equal(migrated.tokenSalt, salt);
    assert.equal(auth.authenticate(device.token).sessionId, device.session.id);
    assert.ok(auth.redeemPairing(pending, 'fixture').token);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { auth.close(); migrated.close(); }
});
