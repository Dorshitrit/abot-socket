import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationTransportFixture } from './notification-transport-fixture.mjs';
import { agentNotificationFrame } from './agent-notification-fixture.mjs';

const features = ['agents_v1', 'agents_notifications_v1'];

test('Agent push works without a Web client or mobile socket; reconnect replay remains one inbox item', async t => {
  const deliveries = [];
  let delivered;
  const ready = new Promise(resolve => { delivered = resolve; });
  const f = await notificationTransportFixture(t, { mode: 'fcm', configured: true,
    send: async item => { deliveries.push(item); delivered(item); return { status: 'delivered' }; } });
  const phone = await f.pair(); const oldApple = await f.pair();
  const token = phone.token;
  assert.equal((await f.request('/v2/notifications/capabilities', { method: 'PUT', body: { agents: true } })).status, 401);
  assert.deepEqual((await f.request('/v2/notifications/capabilities', { method: 'PUT', token, body: { agents: true } })).body,
    { ok: true, agents: true });
  for (const device of [phone, oldApple]) assert.equal((await f.request('/v2/notifications/push', {
    method: 'PUT', token: device.token, body: { provider: 'fcm', token: `fixture-${device.session.id}` },
  })).status, 200);
  const runtime = await f.runtime();
  runtime.send({ type: 'register', agentId: 'test-runtime', features });
  assert.deepEqual((await runtime.next()).agentNotifications, { version: 1 });
  const frame = agentNotificationFrame(Date.now()); runtime.send(frame);
  assert.deepEqual(await runtime.next(), { type: 'agents.notification.ack', eventId: frame.eventId });
  const timeout = setTimeout(() => delivered(null), 3000);
  const delivery = await ready; clearTimeout(timeout); assert.ok(delivery);
  assert.equal(delivery.notification.agentId, 'researcher');
  assert.equal(delivery.registration.token, `fixture-${phone.session.id}`);
  const fresh = await f.request('/v2/notifications?includeAgents=true', { token });
  assert.equal(fresh.body.items.length, 1); assert.equal(fresh.body.items[0].target, 'agent');
  assert.equal((await f.request('/v2/notifications', { token })).body.items.length, 0);
  assert.equal((await f.request('/v2/notifications?includeAgents=true', { token: oldApple.token })).body.items.length, 0);
  runtime.socket.close(); await runtime.closed;
  const next = await f.runtime(); next.send({ type: 'register', agentId: 'test-runtime', features }); await next.next();
  next.send(frame); assert.equal((await next.next()).eventId, frame.eventId);
  assert.equal((await f.request('/v2/notifications?includeAgents=true', { token })).body.items[0].id, fresh.body.items[0].id);
  assert.equal(deliveries.length, 1);
});

test('Agent capability and presence routes are authenticated, strict and device scoped', async t => {
  const f = await notificationTransportFixture(t); const phone = await f.pair(); const token = phone.token;
  const presence = { foreground: true, runtimeId: 'test-runtime', agentId: 'researcher' };
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token, body: presence })).status, 403);
  assert.equal((await f.request('/v2/notifications/capabilities', { method: 'PUT', token, body: { agents: true, deviceId: 'another' } })).status, 400);
  assert.equal((await f.request('/v2/notifications/capabilities', { method: 'PUT', token, body: { agents: true } })).status, 200);
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token, body: presence })).status, 200);
  assert.equal((await f.request('/v2/notifications/capabilities', { method: 'PUT', token, body: { agents: false } })).status, 200);
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token, body: presence })).status, 403);
});
