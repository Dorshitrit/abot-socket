import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationDelivery, validateNotificationDeliveryConfiguration } from '../src/notifications/notification-delivery.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1_700_000_000_000;
const notification = { id: 'n'.repeat(32), kind: 'completed', expiresAt: now + 60_000,
  sessionId: 'private-conversation', runtimeId: 'private-runtime', text: 'private response' };
const registration = { provider: 'fcm', token: 'device-token-123456789' };
const message = { registration, notification, badge: 2 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });

function credentials(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'abot-delivery-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'service-account.json');
  writeFileSync(path, JSON.stringify({ type: 'service_account', project_id: 'test-project',
    client_email: 'test@test-project.iam.gserviceaccount.com', token_uri: 'https://untrusted.invalid/token',
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  return path;
}

function fcm(t, fetchImpl, options = {}) {
  return createNotificationDelivery({ type: 'fcm', serviceAccountFile: credentials(t) },
    { fetchImpl, now: () => now, ...options });
}

test('disabled delivery is inert and provider configuration rejects destinations from arbitrary fields', async () => {
  const off = createNotificationDelivery();
  assert.equal(off.configured, false);
  assert.deepEqual(await off.send(message), { status: 'retry' });
  for (const config of [null, [], { type: 'unknown' }, { type: 'disabled', token: 'x' },
    { type: 'gateway', gatewayOrigin: 'http://gateway.invalid' },
    { type: 'gateway', gatewayOrigin: 'https://user@gateway.invalid' },
    { type: 'gateway', gatewayOrigin: 'https://gateway.invalid/path' },
    { type: 'gateway', gatewayOrigin: 'https://gateway.invalid?x=1' },
    { type: 'fcm', serviceAccountFile: '/tmp/file', private_key: 'secret' }]) {
    assert.throws(() => validateNotificationDeliveryConfiguration(config));
  }
});

test('FCM signs narrow OAuth claims, pins Google endpoints, and emits only a generic notification hint', async (t) => {
  const calls = [];
  const sender = fcm(t, async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? json({ access_token: 'dummy-access-token', expires_in: 3600 })
      : json({ name: 'projects/test-project/messages/one' });
  });
  assert.deepEqual(await sender.send(message), { status: 'delivered' });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const parts = assertion.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url')), {
    iss: 'test@test-project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now / 1000, exp: now / 1000 + 3600,
  });
  assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), pair.publicKey,
    Buffer.from(parts[2], 'base64url')), true);
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/test-project/messages:send');
  const payload = JSON.parse(calls[1].init.body).message;
  assert.deepEqual(payload.data, { notificationId: notification.id });
  assert.deepEqual(payload.notification, { title: 'ABot', body: 'Your response is ready.' });
  assert.deepEqual(payload.apns.payload.aps, { badge: 2, sound: 'default' });
  assert.deepEqual(payload.android, { priority: 'HIGH', ttl: '60s',
    notification: { channel_id: 'abot_updates', tag: notification.id,
      notification_count: 2, default_sound: true } });
  assert.equal(payload.apns.headers['apns-push-type'], 'alert');
  assert.equal(payload.token, registration.token);
  assert.equal(calls[1].init.body.includes('private-'), false);
  assert.equal(calls[1].init.body.includes('private response'), false);
  assert.equal(calls.every((call) => call.init.redirect === 'error'), true);
  await sender.send(message);
  assert.equal(calls.length, 3, 'OAuth token is cached, not refreshed per notification');
});

test('FCM invalid-token responses differ from provider credential/transient errors', async (t) => {
  for (const [response, expected] of [
    [json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, 404), 'invalid'],
    [json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } }, 403), 'retry'],
    [json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }] } }, 400), 'retry'],
    [json({ error: { status: 'INVALID_ARGUMENT' } }, 400), 'retry'],
    [json({ error: { status: 'UNAUTHENTICATED' } }, 401), 'retry'],
    [json({ error: { status: 'QUOTA_EXCEEDED' } }, 429), 'retry'],
    [json({}, 503), 'retry'],
  ]) {
    const sender = fcm(t, async (url) => url.includes('oauth2')
      ? json({ access_token: 'dummy-access', expires_in: 3600 }) : response);
    assert.equal((await sender.send(message)).status, expected);
  }
});

test('credential errors do not reveal paths or values and world-readable/symlink files are rejected', (t) => {
  const path = credentials(t);
  chmodSync(path, 0o644);
  assert.throws(() => createNotificationDelivery({ type: 'fcm', serviceAccountFile: path }),
    (error) => !error.message.includes(path) && error.message.includes('0600'));
  chmodSync(path, 0o600);
  const link = `${path}.link`;
  symlinkSync(path, link);
  assert.throws(() => createNotificationDelivery({ type: 'fcm', serviceAccountFile: link }));
  writeFileSync(path, JSON.stringify({ private_key: 'do-not-print-this' }));
  assert.throws(() => createNotificationDelivery({ type: 'fcm', serviceAccountFile: path }),
    (error) => !error.message.includes('do-not-print-this'));
});

test('malformed recipient is invalid, but discarded notifications never invalidate the recipient', async (t) => {
  let calls = 0;
  const sender = fcm(t, async () => { calls++; throw new Error('should not happen'); });
  for (const invalid of [
    { ...message, registration: { provider: 'gateway', token: registration.token } },
    { ...message, registration: { ...registration, token: '\r\ninjected' } },
  ]) assert.equal((await sender.send(invalid)).status, 'invalid');
  for (const discarded of [
    { ...message, notification: { ...notification, kind: 'arbitrary-content' } },
    { ...message, notification: { ...notification, expiresAt: now } },
    { ...message, badge: -1 },
  ]) assert.equal((await sender.send(discarded)).status, 'discarded');
  assert.equal(calls, 0);
});

test('a notification that expires while OAuth is refreshing is discarded without a device send', async (t) => {
  let clock = now;
  let calls = 0;
  const sender = fcm(t, async () => {
    calls++;
    clock += 120_000;
    return json({ access_token: 'dummy-access-token', expires_in: 3600 });
  }, { now: () => clock });
  assert.equal((await sender.send(message)).status, 'discarded');
  assert.equal(calls, 1);
});

test('Android delivery TTL shrinks after OAuth so it retains the original expiration', async (t) => {
  let clock = now;
  let payload;
  const sender = fcm(t, async (url, init) => {
    if (url.includes('oauth2')) {
      clock += 30_000;
      return json({ access_token: 'dummy-access-token', expires_in: 3600 });
    }
    payload = JSON.parse(init.body).message;
    return json({ name: 'projects/test-project/messages/one' });
  }, { now: () => clock });
  assert.equal((await sender.send(message)).status, 'delivered');
  assert.equal(payload.android.ttl, '30s');
  assert.equal(payload.apns.headers['apns-expiration'], String((now + 60_000) / 1000));
});

test('gateway scope is fixed to operator origin and endpoint credential, with projected data only', async () => {
  const calls = [];
  const sender = createNotificationDelivery({ type: 'gateway', gatewayOrigin: 'https://push.example.invalid' }, {
    now: () => now, fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true }); },
  });
  const gateway = { provider: 'gateway', endpointId: 'e'.repeat(43), sendToken: 's'.repeat(43),
    token: 'must-not-leak', gatewayOrigin: 'https://attacker.invalid' };
  assert.deepEqual(await sender.send({ ...message, registration: gateway }), { status: 'delivered' });
  assert.equal(calls[0].url, 'https://push.example.invalid/v1/deliver');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${gateway.sendToken}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { endpointId: gateway.endpointId,
    notificationId: notification.id, kind: 'completed', expiresAt: notification.expiresAt, badge: 2 });
  assert.equal(calls[0].init.body.includes('must-not-leak'), false);
});

test('redirects, oversized responses, aborts and provider timeouts are bounded retries', async () => {
  const gateway = { provider: 'gateway', endpointId: 'e'.repeat(43), sendToken: 's'.repeat(43) };
  const config = { type: 'gateway', gatewayOrigin: 'https://push.example.invalid' };
  for (const fetchImpl of [
    async () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid' } }),
    async () => new Response('x'.repeat(17 * 1024)),
    async () => new Promise(() => {}),
  ]) {
    const sender = createNotificationDelivery(config, { fetchImpl, now: () => now, timeoutMs: 10 });
    assert.equal((await sender.send({ ...message, registration: gateway })).status, 'retry');
  }
  let calls = 0;
  const sender = createNotificationDelivery(config, { now: () => now,
    fetchImpl: async () => { calls++; return json({ ok: true }); } });
  const abort = new AbortController(); abort.abort();
  assert.equal((await sender.send({ ...message, registration: gateway }, abort.signal)).status, 'retry');
  assert.equal(calls, 0);
});

test('gateway drops an expired message but only explicit recipient rejection invalidates registration', async () => {
  const gateway = { provider: 'gateway', endpointId: 'e'.repeat(43), sendToken: 's'.repeat(43) };
  const config = { type: 'gateway', gatewayOrigin: 'https://push.example.invalid' };
  let calls = 0;
  const expiredSender = createNotificationDelivery(config, { now: () => now,
    fetchImpl: async () => { calls++; return json({ ok: true }); } });
  assert.equal((await expiredSender.send({ ...message, registration: gateway,
    notification: { ...notification, expiresAt: now - 1 } })).status, 'discarded');
  assert.equal(calls, 0);
  for (const [response, expected] of [
    [json({ error: 'unauthorized' }, 401), 'invalid'],
    [json({ error: 'endpoint_unavailable' }, 410), 'invalid'],
    [json({ error: 'proxy_authentication_required' }, 401), 'retry'],
    [json({ error: 'forbidden' }, 403), 'retry'],
    [json({ error: 'not_found' }, 404), 'retry'],
  ]) {
    const sender = createNotificationDelivery(config, { now: () => now, fetchImpl: async () => response });
    assert.equal((await sender.send({ ...message, registration: gateway })).status, expected);
  }
});
