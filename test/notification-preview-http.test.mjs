import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationTransportFixture } from './notification-transport-fixture.mjs';
import { previewKey } from './notification-preview-fixture.mjs';

const route = '/v2/notifications/push/preview';
test('preview API authenticates exact per-device keys, defaults off, and preserves setting through provider rotation', async t => {
  const f = await notificationTransportFixture(t, { mode: 'fcm', configured: true, send: async () => ({ status: 'delivered' }) });
  const first = await f.pair(); const second = await f.pair();
  const call = (method, body = undefined, token = first.token) => f.request(route, { method, token, body });
  assert.equal((await f.request(route, { method: 'PUT', body: previewKey })).status, 401);
  assert.equal((await call('PUT', previewKey)).status, 409);
  await f.request('/v2/notifications/push', { method: 'PUT', token: first.token,
    body: { provider: 'fcm', token: 'dummy-preview-registration' } });
  for (const body of [{ ...previewKey, key: 'invalid' }, { ...previewKey, deviceId: second.session.id },
    { ...previewKey, endpoint: 'https://invalid.test' }, { ...previewKey, keyId: `${previewKey.keyId}=` }]) {
    assert.equal((await call('PUT', body)).status, 400);
  }
  assert.equal((await call('PUT', previewKey)).status, 200);
  const firstList = (await f.request('/v2/notifications', { token: first.token })).body;
  assert.deepEqual(firstList.preview, { supported: true, enabled: true, keyId: previewKey.keyId });
  assert.equal(JSON.stringify(firstList).includes(previewKey.key), false);
  assert.equal((await f.request('/v2/notifications', { token: second.token })).body.preview.enabled, false);
  assert.equal((await call('DELETE', undefined, second.token)).status, 200);
  assert.equal((await f.request('/v2/notifications', { token: first.token })).body.preview.enabled, true);
  await f.request('/v2/notifications/push', { method: 'PUT', token: first.token,
    body: { provider: 'fcm', token: 'dummy-rotated-registration' } });
  assert.equal((await f.request('/v2/notifications', { token: first.token })).body.preview.enabled, true);
  assert.equal((await call('DELETE')).status, 200);
  const disabled = (await f.request('/v2/notifications', { token: first.token })).body;
  assert.deepEqual(disabled.preview, { supported: true, enabled: false, keyId: null });
  assert.equal(disabled.registration.enabled, true);
});
