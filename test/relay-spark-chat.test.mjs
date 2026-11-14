import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';
import { clientCapabilities } from '../src/cli/client-capabilities.mjs';
import { SPARK_SESSION_ID, SPARK_CHAT_FEATURE } from '../src/protocol/spark-chat-protocol.mjs';
import { approvalTransportFixture } from './approval-transport-fixture.mjs';

const open = { type: 'spark.chat.open.request' };
const run = (fields = {}) => ({ type: 'run_request', requestId: 'spark-request',
  sessionId: SPARK_SESSION_ID, text: 'Hello', toolPermissionMode: 'ask', ...fields });
const reply = (command, fields = {}) => ({
  type: 'spark.chat.open.response', correlationId: command.correlationId, ok: true,
  sessionId: SPARK_SESSION_ID, modelProfileId: 'spark', toolPermissionMode: 'ask', readiness: 'ready', ...fields,
});

function fixture() {
  let time = 1_000, sequence = 0;
  const sent = [], failing = new Set();
  const relay = new Relay({ now: () => time, close() {},
    send: (peer, body) => { sent.push({ peer, body: structuredClone(body) }); return !failing.has(peer); },
  });
  const runtime = (runtimeId = 'alpha', { features = [SPARK_CHAT_FEATURE], allowedModes = ['ask'] } = {}) => {
    const peer = { runtimeId, instance: ++sequence };
    assert.equal(relay.attachRuntime(peer, { runtimeId, allowedModes }), true);
    relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, features });
    return peer;
  };
  const client = (allowedRuntimeIds = ['alpha', 'beta']) => {
    const peer = { name: `device-${++sequence}` };
    assert.equal(relay.attachClient(peer, { subject: 'owner', sessionId: peer.name, allowedRuntimeIds }), true);
    return peer;
  };
  const command = (peer, body = open, runtimeId = 'alpha', id = `command-${++sequence}`) => {
    relay.clientMessage(peer, { id, runtimeId, body });
    return id;
  };
  const messages = peer => sent.filter(item => item.peer === peer).map(item => item.body);
  return { relay, runtime, client, command, messages, failing,
    last: peer => messages(peer).at(-1), advance: amount => { time += amount; } };
}

test('SPARK capability combines relay support with the selected online runtime feature', () => {
  const f = fixture(); const capable = f.runtime();
  f.runtime('beta', { features: [] });
  const [alpha, beta, offline] = f.relay.runtimeSnapshot(['alpha', 'beta', 'offline']);
  assert.equal(clientCapabilities({ runtime: alpha }).sparkChat, true);
  assert.equal(clientCapabilities({ runtime: beta }).sparkChat, false);
  assert.equal(clientCapabilities({ runtime: offline }).sparkChat, false);
  f.relay.disconnect(capable);
  assert.equal(clientCapabilities({ runtime: f.relay.runtimeSnapshot(['alpha'])[0] }).sparkChat, false);
});

test('authorized open forwards only relay-owned correlation and projects the response for its client', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); const b = f.client();
  const id = f.command(a);
  const outbound = f.last(r);
  assert.deepEqual(Object.keys(outbound).sort(), ['correlationId', 'type']);
  assert.equal(outbound.type, open.type);
  assert.equal(typeof outbound.correlationId, 'string');
  assert.notEqual(outbound.correlationId, id);
  const publicReply = reply(outbound);
  f.relay.runtimeMessage(r, { ...publicReply, preferences: { secret: 'private-marker' },
    snapshot: { messages: ['private-message'] } });
  assert.deepEqual(f.last(a), { type: 'relay.response', id, runtimeId: 'alpha', body: publicReply });
  assert.equal(f.messages(b).length, 0);
  assert.equal(JSON.stringify(f.messages(a)).includes('private-'), false);
  assert.equal(f.messages(r).filter(body => body.type === 'run_request').length, 0);
});

test('runtime grants and feature support are required before open or SPARK dispatch', () => {
  const f = fixture(); const r = f.runtime('alpha', { features: [] });
  const forbidden = f.client(['beta']);
  f.command(forbidden);
  assert.equal(f.last(forbidden).code, 'runtime_forbidden');
  f.command(forbidden, open, 'beta');
  assert.equal(f.last(forbidden).code, 'runtime_offline');
  const a = f.client();
  f.command(a);
  assert.equal(f.last(a).code, 'spark_chat_unsupported');
  f.command(a, run());
  assert.equal(f.last(a).code, 'spark_chat_unsupported');
  assert.equal(f.messages(r).length, 1);
  const ordinary = run({ sessionId: 'ordinary', modelPreference: { profileId: 'ordinary-model', scope: 'all' } });
  f.command(a, ordinary);
  assert.deepEqual(f.last(r), ordinary);
  assert.equal(f.last(a).type, 'relay.ack');
});

test('read-only open may report a mode above the grant without authorizing that mode for a run', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a);
  f.relay.runtimeMessage(r, reply(f.last(r), { toolPermissionMode: 'full_plus' }));
  assert.equal(f.last(a).body.toolPermissionMode, 'full_plus');
  f.command(a, run({ toolPermissionMode: 'full_plus' }));
  assert.equal(f.last(a).code, 'forbidden');
  assert.equal(f.messages(r).some(body => body.type === 'run_request'), false);
  f.command(a, run());
  assert.deepEqual(f.last(r), run());
  assert.equal(f.last(a).type, 'relay.ack');
});

test('malformed or unrelated replies never consume the pending open correlation', () => {
  const f = fixture(); const r = f.runtime(); const wrong = f.runtime('beta'); const a = f.client();
  const id = f.command(a); const response = reply(f.last(r));
  f.relay.runtimeMessage(wrong, response);
  for (const fields of [
    { type: 'session.snapshot.response' }, { correlationId: 'unknown-correlation' },
    { sessionId: 'other-session' }, { modelProfileId: null }, { readiness: 'unknown' },
    { toolPermissionMode: 'full' }, { modelProfileId: 'x'.repeat(257) },
    { ok: false, error: 'private-diagnostic' },
  ]) f.relay.runtimeMessage(r, { ...response, ...fields });
  assert.equal(f.messages(a).length, 0);
  f.relay.runtimeMessage(r, response);
  assert.equal(f.last(a).id, id);
  assert.equal(f.last(a).type, 'relay.response');
  f.relay.runtimeMessage(r, response);
  assert.equal(f.messages(a).length, 1);
});

test('known failure responses return only their public error code', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  const id = f.command(a);
  const response = { type: 'spark.chat.open.response', correlationId: f.last(r).correlationId,
    ok: false, error: 'spark_chat_session_unavailable' };
  f.relay.runtimeMessage(r, { ...response, message: 'private path', preferences: { secret: 'private' } });
  assert.deepEqual(f.last(a), { type: 'relay.response', id, runtimeId: 'alpha', body: response });
});

test('replaced runtimes cannot complete old opens or consume the replacement correlation', () => {
  const f = fixture(); const old = f.runtime(); const a = f.client();
  f.command(a); const oldReply = reply(f.last(old));
  f.relay.disconnect(old);
  assert.equal(f.last(a).code, 'outcome_unknown');
  const replacement = f.runtime();
  const id = f.command(a); const fresh = reply(f.last(replacement));
  const before = f.messages(a).length;
  f.relay.runtimeMessage(old, oldReply);
  f.relay.runtimeMessage(replacement, oldReply);
  f.relay.runtimeMessage(old, fresh);
  assert.equal(f.messages(a).length, before);
  f.relay.runtimeMessage(replacement, fresh);
  assert.equal(f.last(a).id, id);
  assert.equal(f.last(a).type, 'relay.response');
});

test('expired opens and failed sends report unknown outcome without retrying', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a); const late = reply(f.last(r));
  f.advance(30_001); f.relay.prune();
  assert.equal(f.last(a).code, 'outcome_unknown');
  const before = f.messages(a).length;
  f.relay.runtimeMessage(r, late);
  assert.equal(f.messages(a).length, before);
  assert.equal(f.messages(r).filter(body => body.type === open.type).length, 1);
  f.failing.add(r); f.command(a);
  assert.equal(f.last(a).code, 'outcome_unknown');
  f.failing.delete(r); f.relay.prune();
  assert.equal(f.messages(r).filter(body => body.type === open.type).length, 2);
});

test('disconnecting the client removes its pending open instead of delivering to another device', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a); const response = reply(f.last(r));
  f.relay.disconnect(a);
  const b = f.client();
  f.relay.runtimeMessage(r, response);
  assert.equal(f.messages(a).length, 0);
  assert.equal(f.messages(b).length, 0);
});

test('the SPARK response exception does not weaken ordinary RPC session binding', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a, { type: 'session.list.request' });
  const response = { type: 'session.list.response', correlationId: f.last(r).correlationId, ok: true, sessions: [] };
  f.relay.runtimeMessage(r, { ...response, sessionId: SPARK_SESSION_ID });
  assert.equal(f.messages(a).length, 0);
  f.relay.runtimeMessage(r, response);
  assert.equal(f.last(a).type, 'relay.response');
  assert.deepEqual(f.last(a).body, response);
});

test('HTTP and authenticated WebSocket expose runtime-scoped SPARK support and projected open replies', async (t) => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair();
  const offline = await f.request('/v2/runtimes', { token: login.token });
  assert.equal(offline.status, 200);
  assert.ok(offline.body.runtimes.every(runtime => runtime.capabilities.sparkChat === false));
  const client = await f.client(login.token);
  assert.equal(client.authenticated.capabilities.sparkChat, true);
  const alpha = await f.runtime('alpha', [SPARK_CHAT_FEATURE]);
  await f.runtime('beta', []);
  const catalog = await f.request('/v2/runtimes', { token: login.token });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.runtimes.map(runtime => [runtime.runtimeId, runtime.capabilities.sparkChat]),
    [['alpha', true], ['beta', false]]);
  const id = f.command(client, open);
  const query = await alpha.next(frame => frame.type === open.type);
  assert.deepEqual(Object.keys(query).sort(), ['correlationId', 'type']);
  assert.notEqual(query.correlationId, id);
  const publicReply = reply(query);
  alpha.send({ ...publicReply, preferences: { secret: 'private transport marker' } });
  assert.deepEqual(await client.next(frame => frame.id === id), {
    type: 'relay.response', id, runtimeId: 'alpha', body: publicReply,
  });
});
