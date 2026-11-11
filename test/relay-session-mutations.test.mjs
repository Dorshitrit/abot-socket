import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';

function fixture() {
  let time = 1_000;
  let sequence = 0;
  const sent = [];
  const failing = new Set();
  const relay = new Relay({ now: () => time,
    send: (peer, body) => { sent.push({ peer, body: structuredClone(body) }); return !failing.has(peer); },
    close: () => {},
  });
  const client = (allowedRuntimeIds = ['alpha']) => {
    const peer = {};
    assert.equal(relay.attachClient(peer, { subject: 'owner', sessionId: `device-${++sequence}`, allowedRuntimeIds }), true);
    return peer;
  };
  const runtime = (runtimeId = 'alpha') => {
    const peer = {};
    assert.equal(relay.attachRuntime(peer, { runtimeId }), true);
    relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId });
    return peer;
  };
  const messages = peer => sent.filter(item => item.peer === peer).map(item => item.body);
  return { relay, client, runtime, messages, failing,
    last: peer => messages(peer).at(-1), advance: amount => { time += amount; },
    command: (peer, body, id = `command-${++sequence}`) => {
      relay.clientMessage(peer, { id, runtimeId: 'alpha', body });
      return id;
    },
    snapshot: (peer, fields = {}) => {
      const request = messages(peer).at(-1);
      assert.equal(request.type, 'session.snapshot.request');
      relay.runtimeMessage(peer, { type: 'session.snapshot.response', correlationId: request.correlationId,
        sessionId: request.sessionId, ok: true, requests: [], messages: [], nextCursor: null, ...fields });
    },
  };
}

const remove = { type: 'session.delete.request', sessionId: 'chat-1' };
const clear = { type: 'session.messages.clear.request', sessionId: 'chat-1' };
const removeMessage = { type: 'session.message.delete.request', sessionId: 'chat-1', messageId: '7' };
const run = { type: 'run_request', requestId: 'r-1', sessionId: 'chat-1', text: 'fixture' };
const upload = { type: 'attachment.upload.request', sessionId: 'chat-1', mimeType: 'image/png', data: 'YQ==' };
function result(command, fields = {}) {
  return { type: command.type.replace(/request$/, 'response'), sessionId: command.sessionId,
    correlationId: command.correlationId, ok: true,
    ...(command.type === clear.type ? { cleared: true } : { deleted: true }),
    ...(command.messageId === undefined ? {} : { messageId: command.messageId }), ...fields };
}

test('each mutation waits for a complete idle snapshot and preserves its exact response', () => {
  for (const command of [remove, clear, removeMessage]) {
    const f = fixture(); const runtime = f.runtime(); const client = f.client(); const other = f.client();
    const id = f.command(client, command);
    assert.equal(f.last(runtime).type, 'session.snapshot.request');
    assert.equal(f.last(runtime).includeRequests, true);
    assert.equal(f.messages(client).length, 0);
    assert.equal(f.messages(runtime).filter(body => body.type === command.type).length, 0);
    f.snapshot(runtime, { requests: [{ sessionId: 'chat-1', requestId: 'done', status: 'completed' },
      { sessionId: 'chat-1', requestId: 'failed', status: 'failed' }] });
    const forwarded = f.last(runtime);
    assert.equal(forwarded.type, command.type);
    assert.notEqual(forwarded.correlationId, id);
    const response = result(forwarded, { updatedAt: 123, deletedRequests: 2 });
    f.relay.runtimeMessage(runtime, response);
    assert.deepEqual(f.last(client), { type: 'relay.response', id, runtimeId: 'alpha', body: response });
    assert.equal(f.messages(other).length, 0);
    assert.equal(f.relay.sessionMutations.pending.size, 0);
  }
});

test('ACL and duplicate IDs prevent unauthorized or repeated mutation dispatch', () => {
  const f = fixture(); const runtime = f.runtime(); const restricted = f.client(['beta']); const client = f.client();
  f.command(restricted, remove);
  assert.equal(f.last(restricted).code, 'runtime_forbidden');
  assert.equal(f.messages(runtime).length, 1);
  f.command(client, remove, 'once');
  f.command(client, remove, 'once');
  assert.equal(f.last(client).code, 'duplicate_command');
  assert.equal(f.messages(runtime).filter(body => body.type === 'session.snapshot.request').length, 1);
  f.snapshot(runtime); const mutation = f.last(runtime);
  f.relay.runtimeMessage(runtime, result(mutation));
  f.command(client, remove, 'once');
  assert.equal(f.last(client).code, 'duplicate_command');
  assert.equal(f.messages(runtime).filter(body => body.type === remove.type).length, 1);
});

test('runtime, correlation, session, message and outcome identity cannot be forged', () => {
  const f = fixture(); const runtime = f.runtime(); const otherRuntime = f.runtime('beta'); const client = f.client();
  f.command(client, removeMessage);
  const preflight = f.last(runtime);
  f.relay.runtimeMessage(runtime, { type: 'session.snapshot.response', correlationId: preflight.correlationId,
    ok: true, sessionId: 'other-chat', requests: [], nextCursor: null });
  assert.equal(f.last(runtime), preflight);
  f.snapshot(runtime);
  const mutation = f.last(runtime); const response = result(mutation);
  for (const invalid of [{ ...response, messageId: '8' }, { ...response, sessionId: 'other' },
    { ...response, correlationId: 'guess' }, { ...response, deleted: 'yes' },
    { ...response, type: 'session.delete.response' }, { ...response, requestId: 'injected' }]) {
    f.relay.runtimeMessage(runtime, invalid);
  }
  f.relay.runtimeMessage(otherRuntime, response);
  assert.equal(f.messages(client).length, 0);
  assert.equal(f.relay.correlations.pending.size, 1);
  f.relay.runtimeMessage(runtime, response);
  assert.deepEqual(f.last(client).body, response);
});

test('active and uncertain relay work or outstanding uploads block deletion', () => {
  for (const state of ['active', 'unknown', 'upload']) {
    const f = fixture(); const runtime = f.runtime(); const client = f.client(); const other = f.client();
    if (state === 'unknown') f.failing.add(runtime);
    f.command(client, state === 'upload' ? upload : run);
    f.failing.clear();
    f.command(other, remove);
    assert.equal(f.last(other).code, 'session_busy');
    assert.equal(f.messages(runtime).some(body => body.type === 'session.snapshot.request'), false);
  }
});

test('active or unverifiable canonical state blocks mutation and releases the guard', () => {
  const cases = [
    [{ requests: [{ sessionId: 'chat-1', status: 'streaming' }] }, 'session_busy'],
    [{ requests: [{ sessionId: 'chat-1', status: 'awaiting_approval' }] }, 'session_busy'],
    [{ requests: [{ sessionId: 'chat-1', status: 'new-unknown-status' }] }, 'session_busy'],
    [{ requests: [{ sessionId: 'other', status: 'completed' }] }, 'session_state_unavailable'],
    [{ requests: [null] }, 'session_state_unavailable'],
    [{ requests: undefined }, 'session_state_unavailable'],
    [{ nextCursor: 'partial' }, 'session_state_unavailable'],
    [{ nextCursor: undefined }, 'session_state_unavailable'],
    [{ ok: false, error: 'session_not_found' }, 'session_not_found'],
    [{ ok: false, error: 'private runtime failure detail' }, 'session_state_unavailable'],
  ];
  for (const [body, code] of cases) {
    const f = fixture(); const runtime = f.runtime(); const client = f.client();
    f.command(client, clear); f.snapshot(runtime, body);
    assert.equal(f.last(client).code, code);
    assert.equal(f.messages(runtime).some(body => body.type === clear.type), false);
    assert.equal(f.relay.sessionMutations.pending.size, 0);
    f.command(client, run);
    assert.equal(f.last(client).type, 'relay.ack');
  }
});

test('pending mutation excludes competing session writes but leaves other sessions available', () => {
  const f = fixture(); const runtime = f.runtime(); const client = f.client(); const second = f.client();
  f.command(client, remove);
  for (const command of [removeMessage, clear, run, upload]) {
    f.command(second, command);
    assert.equal(f.last(second).code, 'session_mutation_pending');
  }
  f.command(second, { ...run, sessionId: 'other-chat' });
  assert.equal(f.last(second).type, 'relay.ack');
  const preflight = f.messages(runtime).find(body => body.type === 'session.snapshot.request');
  f.relay.runtimeMessage(runtime, { type: 'session.snapshot.response', correlationId: preflight.correlationId,
    sessionId: 'chat-1', ok: true, requests: [], nextCursor: null });
  f.command(second, clear);
  assert.equal(f.last(second).code, 'session_mutation_pending');
  f.relay.runtimeMessage(runtime, result(f.last(runtime), { ok: false, deleted: false, error: 'storage_failure' }));
  assert.equal(f.last(client).body.ok, false);
  assert.equal(f.last(client).body.deleted, false);
  f.command(second, remove);
  assert.equal(f.last(runtime).type, 'session.snapshot.request');
});

test('client disconnect before deletion stops it; disconnect after dispatch retains the guard', () => {
  for (const dispatched of [false, true]) {
    const f = fixture(); const runtime = f.runtime(); const client = f.client(); const second = f.client();
    f.command(client, remove);
    if (dispatched) f.snapshot(runtime);
    f.relay.disconnect(client);
    f.command(second, clear);
    assert.equal(f.last(second).code, 'session_mutation_pending');
    if (dispatched) f.relay.runtimeMessage(runtime, result(f.last(runtime)));
    else f.snapshot(runtime);
    assert.equal(f.messages(runtime).filter(body => body.type === remove.type).length, dispatched ? 1 : 0);
    assert.equal(f.relay.sessionMutations.pending.size, 0);
    assert.equal(f.messages(client).length, 0);
  }
});

test('timeouts and runtime disconnects report unknown outcomes without retrying', () => {
  for (const phase of ['snapshot', 'delete']) {
    for (const failure of ['timeout', 'disconnect', 'send']) {
      const f = fixture(); const runtime = f.runtime(); const client = f.client();
      if (phase === 'snapshot' && failure === 'send') f.failing.add(runtime);
      f.command(client, remove);
      if (phase === 'delete') {
        if (failure === 'send') f.failing.add(runtime);
        f.snapshot(runtime);
      }
      const before = f.messages(runtime).length;
      if (failure === 'timeout') { f.advance(30_001); f.relay.prune(); }
      if (failure === 'disconnect') f.relay.disconnect(runtime);
      assert.equal(f.last(client).code, 'outcome_unknown');
      assert.equal(f.relay.sessionMutations.pending.size, 0);
      assert.equal(f.relay.correlations.pending.size, 0);
      assert.equal(f.messages(runtime).length, before);
    }
  }
});

test('preflight and mutation share one bounded deadline and false results stay false', () => {
  const f = fixture(); const runtime = f.runtime(); const client = f.client();
  f.command(client, clear); f.advance(29_000); f.snapshot(runtime);
  const mutation = f.last(runtime); f.advance(1_001); f.relay.prune();
  assert.equal(f.last(client).code, 'outcome_unknown');
  f.relay.runtimeMessage(runtime, result(mutation));
  assert.equal(f.last(client).type, 'relay.error');
  f.command(client, removeMessage); f.snapshot(runtime);
  f.relay.runtimeMessage(runtime, result(f.last(runtime), { deleted: false }));
  assert.equal(f.last(client).body.ok, true);
  assert.equal(f.last(client).body.deleted, false);
});
