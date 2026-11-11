import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationEnvelope } from '../src/notifications/notification-delivery-payload.mjs';
import { createNotificationDelivery } from '../src/notifications/notification-delivery.mjs';
import { previewVector as vector } from './notification-preview-fixture.mjs';

const notification = { id: vector.notificationId, kind: 'completed', expiresAt: vector.envelope.expiresAt,
  preview: vector.envelope, output: vector.plaintext, key: vector.key };
test('encrypted pushes carry ciphertext only with Android data-only and iOS generic mutable alert', () => {
  const envelope = notificationEnvelope(notification, 4, vector.now);
  assert.equal(envelope.notification, undefined); assert.equal(envelope.android.notification, undefined);
  assert.deepEqual(envelope.data, { notificationId: notification.id, abotPreview: JSON.stringify(vector.envelope),
    abotKind: 'completed', abotExpiresAt: String(notification.expiresAt), abotBadge: '4' });
  assert.deepEqual(envelope.apns.payload.aps, { badge: 4, sound: 'default',
    alert: { title: 'ABot', body: 'Your response is ready.' }, 'mutable-content': 1 });
  const encoded = JSON.stringify(envelope);
  assert.ok(Buffer.byteLength(encoded) <= 4096);
  assert.equal(encoded.includes(vector.key), false); assert.equal(encoded.includes(vector.plaintext), false);
  for (const preview of [null, { ...vector.envelope, ciphertext: 'bad' }, { ...vector.envelope, extra: 'private' }]) {
    const fallback = notificationEnvelope({ ...notification, preview }, 4, vector.now);
    assert.equal(fallback.notification.body, 'Your response is ready.');
    assert.deepEqual(fallback.data, { notificationId: notification.id });
  }
});

test('Socket gateway adapter forwards only the validated encrypted envelope, never preview key or plaintext', async () => {
  let body;
  const delivery = createNotificationDelivery({ type: 'gateway', gatewayOrigin: 'https://push.example.test' }, {
    now: () => vector.now, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body); return new Response('{"ok":true}', { status: 200 });
    },
  });
  const result = await delivery.send({ notification, badge: 4,
    registration: { provider: 'gateway', endpointId: 'e'.repeat(43), sendToken: 's'.repeat(43) } });
  assert.equal(result.status, 'delivered');
  assert.deepEqual(body.preview, vector.envelope);
  assert.deepEqual(Object.keys(body).sort(), ['badge', 'endpointId', 'expiresAt', 'kind', 'notificationId', 'preview']);
  assert.equal(JSON.stringify(body).includes(vector.key), false);
  assert.equal(JSON.stringify(body).includes(vector.plaintext), false);
});
