import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationTransportFixture } from './notification-transport-fixture.mjs';
import { Relay } from '../src/relay/relay.mjs';

test('phone disconnect still records and delivers only its own completed request', async t => {
  let delivered;
  const received = new Promise(resolve => { delivered = resolve; });
  const f = await notificationTransportFixture(t, { mode: 'fcm', configured: true,
    send: async payload => { delivered(payload); return { status: 'delivered' }; } });
  const first = await f.pair(); const second = await f.pair();
  const token = first.token;
  assert.equal((await f.request('/v2/notifications')).status, 401);
  assert.equal((await f.request('/v2/notifications/push', { method: 'PUT', token,
    body: { provider: 'fcm', token: 'dummy-push-token' } })).status, 200);
  const runtime = await f.runtime();
  runtime.send({ type: 'register', agentId: 'test-runtime' }); await runtime.next();
  const client = await f.client(token);
  assert.equal((await client.next()).capabilities.notifications, true);
  client.send({ id: 'command-1', runtimeId: 'test-runtime', body: {
    type: 'run_request', requestId: 'request-1', sessionId: 'conversation-1', text: 'DUMMY PRIVATE INPUT',
  } });
  await runtime.next(frame => frame.type === 'run_request');
  await client.next(frame => frame.type === 'relay.ack');
  client.socket.close(); await client.closed;
  runtime.send({ type: 'completed', requestId: 'request-1', output: 'DUMMY PRIVATE OUTPUT' });
  const timeout = setTimeout(() => delivered(null), 3000);
  const sent = await received; clearTimeout(timeout);
  assert.ok(sent);
  assert.equal(sent.registration.token, 'dummy-push-token');
  assert.equal(sent.notification.kind, 'completed');
  assert.ok(!JSON.stringify(sent).includes('PRIVATE'));
  const inbox = await f.request('/v2/notifications', { token });
  assert.equal(inbox.body.items.length, 1);
  assert.equal((await f.request('/v2/notifications', { token: second.token })).body.items.length, 0);
  const id = inbox.body.items[0].id;
  await f.request('/v2/notifications/read', { method: 'POST', token: second.token, body: { ids: [id] } });
  assert.equal((await f.request('/v2/notifications', { token })).body.unreadCount, 1);
  await f.request('/v2/notifications/read', { method: 'POST', token, body: { ids: [id] } });
  assert.equal((await f.request('/v2/notifications', { token })).body.unreadCount, 0);
  await f.request('/v2/auth/logout', { method: 'POST', token });
  assert.equal((await f.request('/v2/notifications', { token })).status, 401);
});

test('notification routes validate registration and presence without accepting arbitrary endpoints', async t => {
  const f = await notificationTransportFixture(t);
  const { token } = await f.pair();
  const snapshot = await f.request('/v2/notifications', { token });
  assert.deepEqual(snapshot.body.delivery, { mode: 'disabled', configured: false });
  assert.equal((await f.request('/v2/notifications/push', { method: 'PUT', token,
    body: { provider: 'fcm', token: 'dummy-token' } })).status, 409);
  assert.equal((await f.request('/v2/notifications/push', { method: 'PUT', token,
    body: { provider: 'gateway', endpointId: 'dummy', sendToken: 'dummy', url: 'https://attacker.invalid' } })).status, 400);
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token,
    body: { foreground: true, runtimeId: 'other-runtime' } })).status, 403);
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token,
    body: { foreground: true, runtimeId: 'test-runtime', sessionId: 'conversation-1' } })).status, 200);
  assert.equal((await f.request('/v2/notifications/presence', { method: 'POST', token,
    body: { foreground: false } })).status, 200);
  assert.equal((await f.request('/v2/notifications?limit=101', { token })).status, 400);
  assert.equal((await f.request('/v2/notifications/push', { method: 'DELETE', token })).status, 200);
});

test('notification observer failure does not interrupt validated chat and unknown requests are never projected', () => {
  const frames = [];
  let calls = 0;
  const relay = new Relay({ send: (peer, body) => { frames.push({ peer, body }); return true; }, close: () => {},
    observeRequest: () => { calls += 1; throw new Error('dummy database failure'); } });
  relay.attachRuntime('runtime-peer', { runtimeId: 'runtime' });
  relay.runtimeMessage('runtime-peer', { type: 'register', agentId: 'runtime' });
  relay.attachClient('phone-peer', { subject: 'owner', sessionId: 'device', allowedRuntimeIds: ['runtime'] });
  relay.clientMessage('phone-peer', { id: 'command', runtimeId: 'runtime', body: {
    type: 'run_request', requestId: 'request', sessionId: 'conversation', input: 'test',
  } });
  relay.runtimeMessage('runtime-peer', { type: 'completed', requestId: 'untracked', output: 'ignored' });
  assert.equal(calls, 0);
  assert.doesNotThrow(() => relay.runtimeMessage('runtime-peer', { type: 'completed', requestId: 'request', output: 'done' }));
  assert.equal(calls, 1);
  assert.ok(frames.some(frame => frame.peer === 'phone-peer' && frame.body.type === 'relay.event'));
  assert.ok(frames.filter(frame => frame.peer === 'phone-peer')
    .every(frame => ['relay.ack', 'relay.event'].includes(frame.body.type)));
});
