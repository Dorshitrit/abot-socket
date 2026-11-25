import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';
import { parseAgentNotification, AGENT_NOTIFICATION_RETENTION_MS } from '../src/protocol/agent-notification-protocol.mjs';
import { notificationCapabilities, notificationListOptions, notificationPresence } from '../src/notifications/notification-input.mjs';
import { agentNotificationFrame } from './agent-notification-fixture.mjs';

const time = 1_000_000;

test('strict bounded Agent frames accept Unicode public output and opaque identifiers', () => {
  const frame = agentNotificationFrame(time, { output: '😀'.repeat(600), messageId: 'reply:' + 'x'.repeat(256) });
  assert.ok(parseAgentNotification(frame, time));
  assert.ok(parseAgentNotification({ ...frame, targetAgentId: 'סוכן בדיקה', messageId: 'א'.repeat(4096) }, time));
  const invalid = [
    { runtimeId: 'foreign' }, { deviceId: 'foreign' }, { output: '😀'.repeat(601) },
    { messageId: 'x'.repeat(4097) }, { targetAgentId: 'bad\nname' }, { missionId: '' },
    { eventId: 'not-a-hash' }, { reason: 'progress' }, { reason: 'question', messageId: undefined },
    { reason: 'attention', output: 'fabricated model reply' }, { createdAt: time + 300_001 },
    { expiresAt: time + AGENT_NOTIFICATION_RETENTION_MS + 1 }, { expiresAt: time },
  ];
  for (const fields of invalid) assert.equal(parseAgentNotification({ ...frame, ...fields }, time), null);
  assert.ok(parseAgentNotification(agentNotificationFrame(time, { reason: 'attention', messageId: undefined, output: '' }), time));
});

test('capabilities and presence preserve session validation and reject mixed or foreign targets', () => {
  assert.equal(notificationCapabilities({ agents: true }), true);
  assert.throws(() => notificationCapabilities({ agents: true, deviceId: 'foreign' }));
  assert.throws(() => notificationCapabilities({ agents: 1 }));
  assert.deepEqual(notificationListOptions(new URLSearchParams('includeAgents=true')), { limit: 50, before: null, includeAgents: true });
  assert.deepEqual(notificationListOptions(new URLSearchParams()), { limit: 50, before: null });
  assert.throws(() => notificationListOptions(new URLSearchParams('includeAgents=1')));
  assert.throws(() => notificationListOptions(new URLSearchParams('includeAgents=true&includeAgents=false')));
  assert.deepEqual(notificationPresence({ foreground: true, runtimeId: 'runtime', agentId: 'agent' }, ['runtime']),
    { foreground: true, runtimeId: 'runtime', agentId: 'agent' });
  assert.throws(() => notificationPresence({ foreground: true, runtimeId: 'other', agentId: 'agent' }, ['runtime']));
  assert.throws(() => notificationPresence({ foreground: true, runtimeId: 'runtime', agentId: 'agent', sessionId: 'session' }, ['runtime']));
});

test('explicit notification negotiation and durable observer acceptance are required for ACK', () => {
  const sent = []; const observed = []; let accepts = false;
  const relay = new Relay({ now: () => time, close() {},
    send: (peer, body) => { sent.push({ peer, body }); return true; },
    observeAgentNotification: (runtimeId, event) => { observed.push({ runtimeId, event }); return accepts; } });
  relay.attachRuntime('runtime-peer', { runtimeId: 'runtime' });
  relay.runtimeMessage('runtime-peer', { type: 'register', agentId: 'runtime', features: ['agents_v1', 'agents_notifications_v1'] });
  assert.deepEqual(sent.at(-1).body.agentNotifications, { version: 1 });
  const event = agentNotificationFrame(time);
  relay.runtimeMessage('runtime-peer', event);
  assert.equal(sent.filter(({ body }) => body.type === 'agents.notification.ack').length, 0);
  accepts = true; relay.runtimeMessage('runtime-peer', event);
  assert.deepEqual(sent.at(-1).body, { type: 'agents.notification.ack', eventId: event.eventId });
  assert.equal(observed[0].runtimeId, 'runtime');
  relay.runtimeMessage('runtime-peer', { ...event, runtimeId: 'foreign' });
  assert.equal(observed.length, 2);
  relay.attachRuntime('legacy-peer', { runtimeId: 'legacy' });
  relay.runtimeMessage('legacy-peer', { type: 'register', agentId: 'legacy', features: ['agents_v1'] });
  assert.equal(sent.at(-1).body.agentNotifications, undefined);
  relay.runtimeMessage('legacy-peer', event); assert.equal(observed.length, 2);
  relay.disconnect('runtime-peer'); relay.runtimeMessage('runtime-peer', event);
  assert.equal(observed.length, 2);
});

test('observer storage failure does not ACK or disconnect unrelated live runtime operations', () => {
  const sent = []; const closed = [];
  const relay = new Relay({ now: () => time, close: (...args) => closed.push(args),
    send: (_, body) => { sent.push(body); return true; },
    observeAgentNotification: () => { throw new Error('storage unavailable'); } });
  relay.attachRuntime('peer', { runtimeId: 'runtime' });
  relay.runtimeMessage('peer', { type: 'register', agentId: 'runtime', features: ['agents_v1', 'agents_notifications_v1'] });
  relay.runtimeMessage('peer', agentNotificationFrame(time));
  assert.equal(sent.length, 1); assert.deepEqual(closed, []);
  assert.equal(relay.runtimeSnapshot(['runtime'])[0].online, true);
});
