import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';

function fixture() {
  let time = 1_000;
  let sequence = 0;
  const sent = [];
  const closed = [];
  const failing = new Set();
  const relay = new Relay({ now: () => time,
    send: (peer, body) => { sent.push({ peer, body: structuredClone(body) }); return !failing.has(peer); },
    close: (peer, code, reason) => closed.push({ peer, code, reason }),
  });
  const client = (name = 'client', subject = 'owner', allowedRuntimeIds = ['alpha', 'beta']) => {
    const peer = { name };
    assert.equal(relay.attachClient(peer, { subject, sessionId: `session-${name}`, allowedRuntimeIds }), true);
    return peer;
  };
  const runtime = (runtimeId = 'alpha') => {
    const peer = { runtimeId };
    assert.equal(relay.attachRuntime(peer, { runtimeId, allowedModes: ['ask'] }), true);
    relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, features: ['request_steering_v1'] });
    return peer;
  };
  const command = (peer, body, runtimeId = 'alpha', id = `command-${++sequence}`) => {
    relay.clientMessage(peer, { id, runtimeId, body });
    return id;
  };
  const messages = peer => sent.filter(item => item.peer === peer).map(item => item.body);
  return { relay, sent, closed, failing, client, runtime, command, messages,
    advance: amount => { time += amount; }, last: peer => messages(peer).at(-1) };
}

const run = (requestId = 'request-1') => ({ type: 'run_request', requestId, sessionId: 'chat-1', text: 'hello' });
const approval = (approvalId = 'request-1:approval:1') => ({ type: 'tool_approval_response', approvalId, approved: true });
const required = (approvalId = 'request-1:approval:1') => ({ type: 'event', requestId: 'request-1',
  sessionId: 'chat-1', name: 'tool.approval.required', approvalId });

test('runtime identity is reserved before registration; duplicate cannot replace it', () => {
  const f = fixture(); const runtime = f.runtime(); const duplicate = {};
  assert.equal(f.relay.attachRuntime(duplicate, { runtimeId: 'alpha' }), false);
  f.relay.runtimeMessage(duplicate, { type: 'register', agentId: 'alpha' });
  assert.equal(f.closed.length, 0);
  assert.equal(f.last(runtime).type, 'registered');
  f.relay.runtimeMessage(runtime, { type: 'register', agentId: 'alpha' });
  assert.equal(f.closed.at(-1).reason, 'duplicate_registration');
});

test('registration rejects mismatched identity and oversized or invalid catalogs', () => {
  const f = fixture(); const a = {}; const b = {};
  assert.equal(f.relay.attachRuntime(a, { runtimeId: 'alpha' }), true);
  f.relay.runtimeMessage(a, { type: 'register', agentId: 'beta' });
  assert.equal(f.closed.at(-1).reason, 'runtime_identity_mismatch');
  assert.equal(f.relay.attachRuntime(b, { runtimeId: 'alpha' }), true);
  f.relay.runtimeMessage(b, { type: 'register', agentId: 'alpha', modelCatalog: {
    schemaVersion: 1, defaultProfileId: 'missing', profiles: [{ id: 'present', label: 'Model' }],
  } });
  assert.equal(f.closed.at(-1).reason, 'invalid_model_catalog');
});

test('pre-registration frames and registration timeout cannot retain authority', () => {
  const f = fixture(); const a = {}; const b = {};
  f.relay.attachRuntime(a, { runtimeId: 'alpha' });
  f.relay.runtimeMessage(a, { type: 'event', requestId: 'r' });
  assert.equal(f.closed.at(-1).reason, 'registration_required');
  f.relay.attachRuntime(b, { runtimeId: 'alpha' }); f.advance(5_001); f.relay.prune();
  assert.equal(f.closed.at(-1).reason, 'registration_timeout');
});

test('request creation acknowledges dispatch; only owner subscriptions receive events', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); const b = f.client('second');
  const other = f.client('other', 'different-account');
  f.command(a, run()); assert.equal(f.last(a).type, 'relay.ack');
  f.command(other, { type: 'subscribe_request', requestId: 'request-1' });
  assert.equal(f.last(other).code, 'request_not_owned');
  f.command(b, { type: 'subscribe_request', requestId: 'request-1' });
  f.relay.runtimeMessage(r, { type: 'token', requestId: 'request-1', text: 'answer', eventSequence: 9 });
  assert.equal(f.last(a).type, 'relay.event'); assert.equal(f.last(b).type, 'relay.event');
  assert.equal(f.last(a).body.eventSequence, 9); assert.equal(f.last(a).body.seqNo, undefined);
  assert.equal(f.messages(other).some(body => body.type === 'relay.event'), false);
});

test('runtime ACL, permission ceiling and unavailable identity fail before dispatch', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client('restricted', 'owner', ['beta']);
  f.command(a, run()); assert.equal(f.last(a).code, 'runtime_forbidden');
  f.command(a, run(), 'beta'); assert.equal(f.last(a).code, 'runtime_offline');
  const b = f.client(); f.command(b, { ...run(), toolPermissionMode: 'full_plus' });
  assert.equal(f.last(b).code, 'forbidden'); assert.equal(f.messages(r).length, 1);
});

test('duplicate command and request IDs never dispatch twice', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a, run(), 'alpha', 'same-command');
  f.command(a, run('request-2'), 'alpha', 'same-command');
  assert.equal(f.last(a).code, 'duplicate_command');
  f.command(a, run()); assert.equal(f.last(a).code, 'request_id_conflict');
  assert.equal(f.messages(r).filter(body => body.type === 'run_request').length, 1);
});

test('RPC reply requires exact runtime, response type, request ID and one-use correlation', () => {
  const f = fixture(); const r = f.runtime(); const wrong = f.runtime('beta'); const a = f.client();
  const id = f.command(a, { type: 'request.events.request', requestId: 'historical', afterSeq: 5 });
  const outbound = f.last(r);
  const reply = { type: 'request.events.response', correlationId: outbound.correlationId,
    requestId: 'historical', ok: true, events: [], finalState: null };
  f.relay.runtimeMessage(wrong, reply);
  f.relay.runtimeMessage(r, { ...reply, type: 'session.list.response' });
  f.relay.runtimeMessage(r, { ...reply, requestId: 'other' });
  assert.equal(f.messages(a).length, 0);
  f.relay.runtimeMessage(r, reply); assert.equal(f.last(a).id, id);
  assert.equal(f.last(a).type, 'relay.response');
  f.relay.runtimeMessage(r, reply); assert.equal(f.messages(a).length, 1);
});

test('attachment response is session-bound and accepts actual runtime omission of requestId', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a, { type: 'attachment.upload.request', sessionId: 'chat-1', requestId: 'upload-1',
    mimeType: 'text/plain', kind: 'file', name: 'note.txt', data: Buffer.from('test').toString('base64') });
  const reply = { type: 'attachment.upload.response', correlationId: f.last(r).correlationId,
    sessionId: 'other-chat', ok: true, attachment: {} };
  f.relay.runtimeMessage(r, reply); assert.equal(f.messages(a).length, 0);
  f.relay.runtimeMessage(r, { ...reply, sessionId: 'chat-1', requestId: 'wrong' });
  assert.equal(f.messages(a).length, 0);
  f.relay.runtimeMessage(r, { ...reply, sessionId: 'chat-1' });
  assert.equal(f.last(a).type, 'relay.response');
});

test('approvals require observed owner event, target one runtime, and cannot be reused', () => {
  const f = fixture(); const r = f.runtime(); const other = f.runtime('beta'); const a = f.client();
  f.command(a, run()); f.command(a, approval()); assert.equal(f.last(a).code, 'approval_not_pending');
  f.relay.runtimeMessage(other, required()); f.command(a, approval());
  assert.equal(f.last(a).code, 'approval_not_pending');
  f.relay.runtimeMessage(r, required()); f.command(a, approval());
  assert.equal(f.last(a).type, 'relay.ack'); assert.equal(f.last(r).type, 'tool_approval_response');
  assert.equal(f.messages(other).length, 1);
  f.relay.runtimeMessage(r, required()); f.command(a, approval());
  assert.equal(f.last(a).code, 'approval_not_pending');
});

test('expired approvals and runtime-resolved approvals are not actionable', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.relay.runtimeMessage(r, required()); f.advance(300_001); f.command(a, approval());
  assert.equal(f.last(a).code, 'approval_not_pending');
  f.relay.runtimeMessage(r, required('approval-2'));
  f.relay.runtimeMessage(r, { ...required('approval-2'), name: 'tool.approval.granted' });
  f.command(a, approval('approval-2')); assert.equal(f.last(a).code, 'approval_not_pending');
  f.command(a, { ...approval('approval-2'), approved: false }); assert.equal(f.last(a).code, 'approval_not_pending');
});

test('steering binds request, steer ID and socket; terminal requests cannot be steered', () => {
  const f = fixture(); const r = f.runtime(); const other = f.runtime('beta'); const a = f.client();
  f.command(a, run()); f.command(a, { type: 'steer_request', requestId: 'request-1', steerId: 'steer-1', text: 'stop' });
  const count = f.messages(a).length;
  const ack = { type: 'steer_ack', requestId: 'request-1', steerId: 'steer-1', accepted: true, acceptedSequence: 1 };
  f.relay.runtimeMessage(other, ack); f.relay.runtimeMessage(r, { ...ack, steerId: 'wrong' });
  assert.equal(f.messages(a).length, count);
  f.relay.runtimeMessage(r, ack); assert.equal(f.last(a).type, 'relay.response');
  f.relay.runtimeMessage(r, { type: 'completed', requestId: 'request-1', output: 'done' });
  f.command(a, { type: 'steer_request', requestId: 'request-1', steerId: 'steer-2', text: 'again' });
  assert.equal(f.last(a).code, 'request_not_active');
});

test('disconnect reports unknown outcomes; old socket never owns replacement events', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.command(a, { type: 'session.list.request' }); const rpc = f.last(r);
  f.relay.disconnect(r); assert.equal(f.last(a).code, 'outcome_unknown');
  const replacement = f.runtime(); const count = f.messages(a).length;
  const reply = { type: 'session.list.response', correlationId: rpc.correlationId, ok: true, sessions: [] };
  f.relay.runtimeMessage(r, reply); f.relay.runtimeMessage(replacement, reply);
  f.relay.runtimeMessage(replacement, { type: 'token', requestId: 'request-1', text: 'late' });
  assert.equal(f.messages(a).length, count);
});

test('timeout and send failure report outcome_unknown without retry', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.command(a, { type: 'session.list.request' }); f.advance(30_001); f.relay.prune();
  assert.equal(f.last(a).code, 'outcome_unknown');
  f.failing.add(r); f.command(a, run()); assert.equal(f.last(a).code, 'outcome_unknown');
  f.failing.delete(r); f.command(a, run()); assert.equal(f.last(a).code, 'request_id_conflict');
  assert.equal(f.messages(r).filter(body => body.type === 'run_request').length, 1);
});

test('client disconnect removes subscriptions and pending replies', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.command(a, { type: 'session.list.request' }); const rpc = f.last(r);
  f.relay.disconnect(a); const count = f.messages(a).length;
  f.relay.runtimeMessage(r, { type: 'token', requestId: 'request-1', text: 'hidden' });
  f.relay.runtimeMessage(r, { type: 'session.list.response', correlationId: rpc.correlationId, ok: true, sessions: [] });
  assert.equal(f.messages(a).length, count);
});

test('command rate and global pending capacity are bounded', () => {
  const f = fixture(); f.runtime(); const a = f.client();
  for (let i = 0; i < 61; i += 1) f.command(a, { type: 'session.list.request' });
  assert.equal(f.last(a).code, 'rate_limited');
  const b = f.client('b'); const c = f.client('c');
  for (let i = 0; i < 60; i += 1) f.command(b, { type: 'session.list.request' });
  for (let i = 0; i < 9; i += 1) f.command(c, { type: 'session.list.request' });
  assert.equal(f.last(c).code, 'pending_capacity');
});

test('active request admission is bounded without evicting an owner', () => {
  const f = fixture(); const r = f.runtime(); const peers = [f.client('a'), f.client('b'), f.client('c')];
  for (let i = 0; i < 129; i += 1) f.command(peers[Math.floor(i / 50)], run(`request-${i}`));
  assert.equal(f.last(peers[2]).code, 'active_request_capacity');
  assert.equal(f.messages(r).filter(body => body.type === 'run_request').length, 128);
});

test('invalid and over-limit runtime frames close the peer', () => {
  const f = fixture(); const r = f.runtime(); f.relay.runtimeMessage(r, []);
  assert.equal(f.closed.at(-1).reason, 'invalid_runtime_frame');
  const next = f.runtime(); f.relay.runtimeMessage(next, { type: 'event', payload: 'x'.repeat(16 * 1024 * 1024) });
  assert.equal(f.closed.at(-1).reason, 'invalid_runtime_frame');
});

test('command dedup capacity rejects new work instead of evicting an old command ID', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  for (let i = 0; i < 512; i += 1) {
    f.advance(2_000); f.command(a, { type: 'session.list.request' }, 'alpha', `id-${i}`);
    f.relay.runtimeMessage(r, { type: 'session.list.response', correlationId: f.last(r).correlationId,
      ok: true, sessions: [] });
  }
  f.command(a, { type: 'session.list.request' }, 'alpha', 'new-id');
  assert.equal(f.last(a).code, 'command_capacity');
  f.command(a, { type: 'session.list.request' }, 'alpha', 'id-0');
  assert.equal(f.last(a).code, 'duplicate_command');
});

test('failed approval delivery is unknown and never reopens the consumed decision', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.relay.runtimeMessage(r, required()); f.failing.add(r); f.command(a, approval());
  assert.equal(f.last(a).code, 'outcome_unknown');
  f.failing.delete(r); f.command(a, approval()); assert.equal(f.last(a).code, 'approval_not_pending');
  assert.equal(f.messages(r).filter(body => body.type === 'tool_approval_response').length, 1);
});

test('terminal events close pending approvals and stop later stream delivery', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.relay.runtimeMessage(r, required());
  f.relay.runtimeMessage(r, { type: 'completed', requestId: 'request-1', output: 'done' });
  const count = f.messages(a).length;
  f.relay.runtimeMessage(r, { type: 'token', requestId: 'request-1', text: 'late' });
  assert.equal(f.messages(a).length, count);
  f.command(a, approval()); assert.equal(f.last(a).code, 'approval_not_pending');
  f.command(a, { ...approval(), approved: false }); assert.equal(f.last(a).code, 'approval_not_pending');
});

test('expired observed approval allows one explicit decline, never positive approval or a new runtime', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run());
  f.relay.runtimeMessage(r, required()); const before = f.messages(r).length;
  f.advance(300_001); f.relay.prune(); assert.equal(f.messages(r).length, before);
  f.command(a, approval()); assert.equal(f.last(a).code, 'approval_not_pending');
  f.command(a, { ...approval(), approved: false });
  assert.equal(f.last(a).type, 'relay.ack'); assert.equal(f.last(r).approved, false);
  f.command(a, { ...approval(), approved: false });
  assert.equal(f.last(a).code, 'approval_not_pending');
  assert.equal(f.messages(r).filter(body => body.type === 'tool_approval_response').length, 1);
  f.relay.runtimeMessage(r, required('approval-2')); f.advance(300_001);
  f.relay.disconnect(r); const replacement = f.runtime();
  f.command(a, { ...approval('approval-2'), approved: false });
  assert.equal(f.last(a).code, 'approval_not_pending'); assert.equal(f.messages(replacement).length, 1);
});
