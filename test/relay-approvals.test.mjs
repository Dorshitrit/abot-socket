import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';

function fixture({ storage = true } = {}) {
  let time = 1_000;
  let sequence = 0;
  const sent = [], observed = [], rows = new Map(), failing = new Set();
  const key = (runtimeId, requestId) => JSON.stringify([runtimeId, requestId]);
  const ownership = {
    isOwnerSubject: subject => subject === 'owner',
    adopt(record, terminal = false) {
      const existing = ownership.get(record.runtimeId, record.requestId);
      if (existing) {
        assert.equal(existing.subject, record.subject);
        assert.equal(existing.sessionId, record.sessionId);
        return existing;
      }
      ownership.create(record);
      if (terminal) ownership.markTerminal(record.runtimeId, record.requestId);
      return ownership.get(record.runtimeId, record.requestId);
    },
    create(record) {
      if (rows.has(key(record.runtimeId, record.requestId))) throw Object.assign(new Error(), { code: 'request_id_conflict' });
      if (rows.size >= 512) throw Object.assign(new Error(), { code: 'request_capacity' });
      rows.set(key(record.runtimeId, record.requestId), { ...record, status: 'open', createdAt: time, terminalAt: null });
    },
    get: (runtimeId, requestId) => structuredClone(rows.get(key(runtimeId, requestId)) ?? null),
    listSession: (runtimeId, sessionId) => [...rows.values()].filter(row => row.runtimeId === runtimeId
      && row.sessionId === sessionId).map(row => structuredClone(row)),
    markTerminal(runtimeId, requestId) {
      const row = rows.get(key(runtimeId, requestId));
      if (row?.status === 'open') Object.assign(row, { status: 'terminal', terminalAt: time });
    },
    retireSession(runtimeId, sessionId) {
      for (const [id, row] of rows) if (row.runtimeId === runtimeId && row.sessionId === sessionId) rows.delete(id);
    },
    prune() {
      for (const [id, row] of rows) if (row.status === 'terminal' && time - row.terminalAt >= 43_200_000) rows.delete(id);
    },
  };
  const f = { sent, observed, ownership, rows, failing,
    restart() {
      f.relay = new Relay({ now: () => time, ownership: storage ? ownership : undefined,
        send: (peer, body) => {
          if (body.type === 'run_request' && body.approvalMode) {
            assert.equal(ownership.get(peer.runtimeId, body.requestId)?.status, 'open');
          }
          sent.push({ peer, body: structuredClone(body) });
          return !failing.has(peer);
        }, close() {}, observeRequest: (identity, body) => observed.push({ identity, body }) });
      return f.relay;
    },
    runtime(runtimeId = 'alpha', features = ['request_approvals_v1', 'request_steering_v1']) {
      const peer = { runtimeId, instance: ++sequence };
      assert.equal(f.relay.attachRuntime(peer, { runtimeId }), true);
      f.relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, features });
      return peer;
    },
    client(subject = 'owner') {
      const peer = { deviceId: `device-${++sequence}` };
      assert.equal(f.relay.attachClient(peer, { subject, sessionId: peer.deviceId, allowedRuntimeIds: ['alpha', 'beta'] }), true);
      return peer;
    },
    command(peer, body, runtimeId = 'alpha') {
      const id = `command-${++sequence}`;
      f.relay.clientMessage(peer, { id, runtimeId, body });
      return id;
    },
    messages: peer => sent.filter(item => item.peer === peer).map(item => item.body),
    last: peer => f.messages(peer).at(-1),
    advance: amount => { time += amount; },
    reply(peer, fields = {}) {
      const command = f.last(peer);
      const body = { type: command.type.replace(/request$/, 'response'),
        correlationId: command.correlationId, sessionId: command.sessionId, requestId: command.requestId,
        ok: true, ...(command.type === recover.type ? { approvals: [], lifecycle: null, finalState: null }
          : { result: { accepted: true } }), ...fields };
      f.relay.runtimeMessage(peer, body);
      return body;
    },
  };
  f.restart();
  return f;
}

const run = { type: 'run_request', requestId: 'req-1', sessionId: 'chat-1', text: 'hello', approvalMode: 'durable_v1' };
const recover = { type: 'request.approvals.request', requestId: 'req-1', sessionId: 'chat-1' };
const decide = { type: 'request.approval.decide.request', requestId: 'req-1', sessionId: 'chat-1',
  approvalId: 'approval-1', approved: true, generation: 'generation-1', waitId: 'wait-1', revision: 2, commandId: 'decision-1' };
const required = { type: 'event', requestId: 'req-1', sessionId: 'chat-1', name: 'tool.approval.required', approvalId: 'approval-1' };
const complete = { type: 'completed', requestId: 'req-1', sessionId: 'chat-1', output: 'done' };

test('durable admission requires storage and feature; absent opt-in retains legacy behavior', () => {
  for (const storage of [true, false]) {
    const f = fixture({ storage }); const r = f.runtime('alpha', storage ? [] : ['request_approvals_v1']); const a = f.client();
    f.command(a, run);
    assert.equal(f.last(a).code, storage ? 'approvals_unsupported' : 'approval_access_unavailable');
    assert.equal(f.messages(r).length, 1);
    const legacy = { ...run }; delete legacy.approvalMode;
    f.command(a, legacy);
    assert.equal(f.last(a).type, 'relay.ack');
    assert.equal(f.ownership.get('alpha', run.requestId), null);
    f.relay.runtimeMessage(r, required);
    f.command(a, { type: 'tool_approval_response', approvalId: 'approval-1', approved: true });
    assert.equal(f.last(a).type, 'relay.ack');
  }
});

test('persist-before-send prevents duplicate execution after unknown transport and relay restart', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  f.failing.add(r); f.command(a, run);
  assert.equal(f.last(a).code, 'outcome_unknown');
  f.advance(30 * 24 * 60 * 60 * 1000); f.restart();
  const next = f.runtime(); const b = f.client();
  for (const command of [run, { ...run, approvalMode: undefined }]) {
    const body = { ...command }; if (!body.approvalMode) delete body.approvalMode;
    f.command(b, body); assert.equal(f.last(b).code, 'request_id_conflict');
  }
  assert.equal(f.messages(next).length, 1);
  assert.equal(f.ownership.get('alpha', 'req-1').status, 'open');
});

test('recovery restores only the durable owner scope and routes pre-response events to another owner device', () => {
  const f = fixture(); f.runtime(); const original = f.client(); f.command(original, run);
  f.restart(); const r = f.runtime(); const b = f.client(); const stranger = f.client('different-owner');
  for (const [client, command] of [[stranger, recover], [b, { ...recover, sessionId: 'wrong' }]]) {
    f.command(client, command); assert.equal(f.last(client).code, 'request_not_owned');
  }
  assert.equal(f.messages(r).length, 1);
  f.command(b, { ...recover, requestId: 'historical-unowned' });
  const proof = f.last(r);
  assert.equal(proof.type, 'session.snapshot.request');
  f.relay.runtimeMessage(r, { type: 'session.snapshot.response', correlationId: proof.correlationId,
    sessionId: recover.sessionId, ok: true, requests: [], nextCursor: null });
  assert.equal(f.last(b).code, 'request_scope_unverified');
  assert.equal(f.ownership.get('alpha', 'historical-unowned'), null);
  f.command(b, recover);
  const outbound = f.last(r);
  f.relay.runtimeMessage(r, required);
  assert.equal(f.last(b).body.name, required.name);
  assert.equal(f.observed.at(-1).identity.deviceId, original.deviceId);
  f.relay.runtimeMessage(r, { type: 'request.approvals.response', correlationId: outbound.correlationId,
    sessionId: run.sessionId, requestId: run.requestId, ok: true, approvals: [{
      request: { requestId: run.requestId, approvalId: 'approval-1' },
      wait: { generation: 'generation-1', waitId: 'wait-1', revision: 2 },
    }], lifecycle: null, finalState: null });
  assert.equal(f.last(b).type, 'relay.response');
  assert.equal(f.messages(stranger).some(body => body.type === 'relay.event'), false);
  assert.equal(f.messages(r).some(body => body.type === 'run_request'), false);
});

test('durable approval events do not authorize legacy decisions or expire after five minutes', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run);
  f.relay.runtimeMessage(r, required); f.advance(13 * 60 * 60 * 1000); f.relay.prune();
  f.command(a, { type: 'tool_approval_response', approvalId: 'approval-1', approved: true });
  assert.equal(f.last(a).code, 'approval_not_pending');
  f.command(a, decide); assert.equal(f.last(r).type, decide.type);
  f.reply(r);
  assert.equal(f.last(a).body.result.accepted, true);
  assert.equal(f.messages(r).some(body => body.type === 'tool_approval_response'), false);
});

test('consumed receipt retry after relay restart binds running events before its response', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); f.command(a, run); f.command(a, decide);
  f.reply(r); f.restart(); const next = f.runtime(); const b = f.client();
  f.command(b, decide);
  const command = f.last(next);
  f.relay.runtimeMessage(next, complete);
  assert.equal(f.last(b).body.type, 'completed');
  assert.equal(f.ownership.get('alpha', 'req-1').status, 'terminal');
  f.relay.runtimeMessage(next, { type: 'request.approval.decide.response', correlationId: command.correlationId,
    requestId: run.requestId, sessionId: run.sessionId, ok: true, result: { accepted: true, duplicate: true } });
  assert.equal(f.last(b).body.result.duplicate, true);
  assert.equal(f.messages(next).filter(body => body.type === decide.type).length, 1);
  assert.equal(f.messages(next).some(body => body.type === 'run_request'), false);
});

test('exact runtime connection, correlation, session, request and response shape are required', () => {
  const f = fixture(); const r = f.runtime(); const wrong = f.runtime('beta'); const a = f.client();
  f.command(a, run); f.command(a, recover); const command = f.last(r);
  const response = { type: 'request.approvals.response', correlationId: command.correlationId,
    requestId: run.requestId, sessionId: run.sessionId, ok: true, approvals: [], lifecycle: null, finalState: null };
  const count = f.messages(a).length;
  for (const invalid of [{ ...response, requestId: 'wrong' }, { ...response, requestId: undefined },
    { ...response, sessionId: 'wrong' }, { ...response, correlationId: 'guessed' },
    { ...response, approvals: [{ request: { requestId: 'wrong', approvalId: 'a' } }] },
    { ...response, lifecycle: { sessionId: 'wrong' } }, { ...response, finalState: { status: 'streaming' } }]) {
    f.relay.runtimeMessage(r, invalid);
  }
  f.relay.runtimeMessage(wrong, response);
  assert.equal(f.messages(a).length, count); assert.equal(f.relay.correlations.pending.size, 1);
  f.relay.disconnect(r); const replacement = f.runtime(); const after = f.messages(a).length;
  f.relay.runtimeMessage(r, response); f.relay.runtimeMessage(replacement, response);
  f.relay.runtimeMessage(replacement, required);
  assert.equal(f.messages(a).length, after);
  f.command(a, recover); f.reply(replacement);
  assert.equal(f.last(a).type, 'relay.response');
});

test('rejected decision restores only its new view and preserves existing subscribers', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client(); const b = f.client();
  f.command(a, run); f.command(b, decide); f.reply(r, { result: { accepted: false, reason: 'approval_identity_mismatch' } });
  const count = f.messages(b).length;
  f.relay.runtimeMessage(r, required);
  assert.equal(f.last(a).type, 'relay.event'); assert.equal(f.messages(b).length, count);
  f.restart(); const next = f.runtime(); const c = f.client();
  f.command(c, decide); f.reply(next, { ok: false, error: 'approval_access_unavailable' });
  assert.equal(f.relay.requests.bindings.size, 0);
  assert.equal(f.ownership.get('alpha', 'req-1').status, 'open');
});

test('client disconnect removes the view but keeps uncertain approval RPC and durable owner', () => {
  const f = fixture(); f.runtime(); const a = f.client(); f.command(a, run);
  f.restart(); const r = f.runtime(); const b = f.client(); f.command(b, recover);
  f.relay.disconnect(b); const count = f.messages(b).length;
  assert.equal(f.relay.correlations.pending.size, 1);
  f.relay.runtimeMessage(r, required); f.reply(r);
  assert.equal(f.messages(b).length, count); assert.equal(f.relay.correlations.pending.size, 0);
  assert.equal(f.ownership.get('alpha', 'req-1').status, 'open');
});

test('terminal recovery persists finality, blocks later events and retains idempotent receipt access', () => {
  const f = fixture(); f.runtime(); const a = f.client(); f.command(a, run);
  f.restart(); const r = f.runtime(); const b = f.client(); f.command(b, recover);
  f.reply(r, { finalState: { status: 'completed', output: 'done', completedAt: 2_000 } });
  assert.equal(f.ownership.get('alpha', 'req-1').status, 'terminal');
  const count = f.messages(b).length; f.relay.runtimeMessage(r, required);
  assert.equal(f.messages(b).length, count);
  f.command(b, decide); f.reply(r, { result: { accepted: true, duplicate: true } });
  assert.equal(f.last(b).body.result.duplicate, true);
});

test('recovery capacity refuses admission without losing stored work or existing views', () => {
  const f = fixture(); const r = f.runtime(); const a = f.client();
  for (let i = 0; i < 129; i += 1) {
    f.ownership.create({ subject: 'owner', deviceId: a.deviceId, runtimeId: 'alpha',
      sessionId: 'chat-1', requestId: `saved-${i}` });
  }
  for (let i = 0; i < 128; i += 1) {
    f.advance(2_000); f.command(a, { ...recover, requestId: `saved-${i}` }); f.reply(r);
  }
  f.command(a, { ...recover, requestId: 'saved-128' });
  assert.equal(f.last(a).code, 'active_request_capacity');
  assert.equal(f.relay.requests.bindings.size, 128); assert.equal(f.rows.size, 129);
  assert.equal(f.relay.correlations.pending.size, 0);
  f.relay.runtimeMessage(r, { ...complete, requestId: 'saved-0' });
  f.command(a, { ...recover, requestId: 'saved-128' }); f.reply(r);
  assert.equal(f.last(a).type, 'relay.response');
  assert.equal(f.relay.requests.bindings.size, 129);
});

test('pending approval access blocks session deletion until its bounded RPC outcome', () => {
  const f = fixture(); f.runtime(); const a = f.client(); f.command(a, run);
  f.restart(); const r = f.runtime(); const b = f.client(); f.command(b, recover);
  f.command(b, decide); assert.equal(f.last(b).code, 'approval_request_pending');
  f.command(b, { type: 'session.delete.request', sessionId: 'chat-1' });
  assert.equal(f.last(b).code, 'session_busy');
  f.relay.disconnect(b); const c = f.client();
  f.command(c, { type: 'session.delete.request', sessionId: 'chat-1' });
  assert.equal(f.last(c).code, 'session_busy');
  f.advance(30_001); f.relay.prune();
  f.command(c, { type: 'session.delete.request', sessionId: 'chat-1' });
  assert.equal(f.last(r).type, 'session.snapshot.request');
  f.command(c, recover); assert.equal(f.last(c).code, 'session_mutation_pending');
});

test('unknown persisted work needs exact terminal proof before any session mutation', () => {
  for (const canonical of [[], [{ requestId: 'other', sessionId: 'chat-1', status: 'completed' }],
    [{ requestId: 'req-1', sessionId: 'chat-1', status: 'streaming' }]]) {
    const f = fixture(); f.runtime(); const a = f.client(); f.command(a, run);
    f.restart(); const r = f.runtime(); const b = f.client();
    f.command(b, { type: 'session.delete.request', sessionId: 'chat-1' });
    const command = f.last(r);
    f.relay.runtimeMessage(r, { type: 'session.snapshot.response', correlationId: command.correlationId,
      sessionId: 'chat-1', ok: true, requests: canonical, nextCursor: null });
    assert.equal(f.last(b).code, 'session_busy');
    assert.equal(f.ownership.get('alpha', 'req-1').status, 'open');
    assert.equal(f.messages(r).some(body => body.type === 'session.delete.request'), false);
  }
});

test('only confirmed complete session removal retires ownership after canonical terminal proof', () => {
  for (const [type, success, retired] of [['session.delete.request', true, true],
    ['session.delete.request', false, false], ['session.messages.clear.request', true, true],
    ['session.message.delete.request', true, false]]) {
    const f = fixture(); f.runtime(); const a = f.client(); f.command(a, run);
    f.restart(); const r = f.runtime(); const b = f.client();
    f.command(b, { type, sessionId: 'chat-1', ...(type.includes('message.delete') ? { messageId: '7' } : {}) });
    const snapshot = f.last(r);
    f.relay.runtimeMessage(r, { type: 'session.snapshot.response', correlationId: snapshot.correlationId,
      sessionId: 'chat-1', ok: true, requests: [{ requestId: 'req-1', sessionId: 'chat-1', status: 'completed' }],
      nextCursor: null });
    const mutation = f.last(r);
    assert.equal(mutation.type, type); assert.equal(f.ownership.get('alpha', 'req-1').status, 'terminal');
    f.relay.runtimeMessage(r, { type: type.replace(/request$/, 'response'), correlationId: mutation.correlationId,
      sessionId: 'chat-1', ok: true, ...(type.includes('clear') ? { cleared: success } : { deleted: success }),
      ...(mutation.messageId ? { messageId: mutation.messageId } : {}) });
    assert.equal(f.ownership.get('alpha', 'req-1') === null, retired);
  }
});
