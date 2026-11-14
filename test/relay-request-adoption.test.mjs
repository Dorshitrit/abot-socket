import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptionFixture, recovery } from './relay-request-adoption-fixture.mjs';

const decision = { type: 'request.approval.decide.request', sessionId: recovery.sessionId,
  requestId: recovery.requestId, approvalId: 'approval-1', approved: true,
  generation: 'generation-1', waitId: 'wait-1', revision: 7, commandId: 'decision-1' };

test('computer request is adopted only after canonical proof, then uses unchanged recovery and decisions', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client();
  const id = f.command(a);
  assert.equal(f.last(r).type, 'session.snapshot.request');
  assert.equal(f.owner(), null);
  assert.equal(f.messages(a).length, 0);
  f.snapshot(r);
  assert.equal(f.owner().sessionId, recovery.sessionId);
  assert.equal(f.owner().deviceId, a.deviceId);
  assert.equal(f.last(r).type, recovery.type);
  f.recovered(r);
  assert.equal(f.last(a).id, id);
  assert.equal(f.last(a).body.approvals[0].wait.revision, decision.revision);
  f.command(a, decision);
  const { correlationId, ...forwarded } = f.last(r);
  assert.ok(correlationId);
  assert.deepEqual(forwarded, decision);
  f.relay.runtimeMessage(r, { type: 'request.approval.decide.response', correlationId,
    sessionId: recovery.sessionId, requestId: recovery.requestId, ok: true,
    result: { accepted: false, reason: 'stale_wait' } });
  assert.equal(f.last(a).body.result.reason, 'stale_wait');
  assert.equal(f.messages(r).some(body => body.type === 'run_request'), false);
});

test('decisions never bootstrap ownership and runtimes without approval support fail closed', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client();
  f.command(a, decision);
  assert.equal(f.last(a).code, 'request_not_owned');
  assert.equal(f.messages(r).length, 1);
  const unsupported = f.runtime('legacy', []), b = f.client(undefined, ['legacy']);
  f.command(b, recovery, 'legacy');
  assert.equal(f.last(b).code, 'approvals_unsupported');
  assert.equal(f.messages(unsupported).length, 1);
});

test('failed, absent, duplicate, partial or wrong-scope proof never creates a binding', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client();
  const expected = { sessionId: recovery.sessionId, requestId: recovery.requestId, status: 'awaiting_approval' };
  for (const override of [{ ok: false }, { requests: [] }, { nextCursor: 'partial' },
    { requests: [expected, expected] }, { requests: [{ ...expected, sessionId: 'other-chat' }] },
    { requests: [{ ...expected, status: 'unknown' }] }]) {
    f.command(a); f.snapshot(r, override);
    assert.equal(f.last(a).code, 'request_scope_unverified');
    assert.equal(f.owner(), null);
    assert.equal(f.relay.requests.bindings.size, 0);
  }
});

test('foreign subjects, ungranted runtimes and existing foreign session bindings are not adopted', t => {
  const f = adoptionFixture(t), r = f.runtime(), stranger = f.client('different-owner');
  f.command(stranger);
  assert.equal(f.last(stranger).code, 'request_not_owned');
  const denied = f.client(undefined, ['other']); f.command(denied);
  assert.equal(f.last(denied).code, 'runtime_forbidden');
  assert.equal(f.messages(r).length, 1);
  const original = f.store.create(f.identity({ requestId: recovery.requestId, sessionId: 'other-chat' }));
  const a = f.client(); f.command(a);
  assert.equal(f.last(a).code, 'request_not_owned');
  assert.deepEqual(f.owner(), original);
  assert.equal(f.messages(r).length, 1);
});

test('pending proof blocks only conflicting runs, approval operations and session mutations', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client(); f.command(a);
  for (const command of [recovery, decision,
    { type: 'run_request', requestId: recovery.requestId, sessionId: recovery.sessionId, text: 'not replayed' }]) {
    f.command(a, command); assert.equal(f.last(a).code, 'approval_request_pending');
  }
  f.command(a, { type: 'session.delete.request', sessionId: recovery.sessionId });
  assert.equal(f.last(a).code, 'session_busy');
  assert.equal(f.messages(r).length, 2);
  f.command(a, { type: 'session.delete.request', sessionId: 'unrelated-chat' });
  assert.equal(f.last(r).type, 'session.snapshot.request');
  assert.equal(f.last(r).sessionId, 'unrelated-chat');
  assert.equal(f.owner(), null);
});

test('disconnect, revocation, runtime replacement and timeout cannot commit late proof', t => {
  for (const event of ['client-close', 'revoked', 'runtime-close', 'timeout']) {
    const f = adoptionFixture(t), r = f.runtime(), a = f.client(); f.command(a);
    const query = f.last(r);
    if (event === 'client-close') f.relay.disconnect(a);
    if (event === 'revoked') f.revoked.add(a);
    if (event === 'runtime-close') { f.relay.disconnect(r); f.runtime(); }
    if (event === 'timeout') { f.advance(30_001); f.relay.prune(); }
    f.relay.runtimeMessage(r, { type: 'session.snapshot.response', correlationId: query.correlationId,
      sessionId: recovery.sessionId, ok: true, nextCursor: null,
      requests: [{ ...recovery, status: 'awaiting_approval' }] });
    assert.equal(f.owner(), null, event);
    assert.equal(f.relay.requests.bindings.size, 0, event);
  }
});

test('same-owner devices share recovered authority without changing the originating device', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client();
  f.command(a); f.snapshot(r); f.recovered(r);
  const original = f.owner();
  f.relay.disconnect(a);
  const b = f.client(); f.command(b);
  assert.equal(f.last(r).type, recovery.type);
  f.recovered(r); f.command(b, decision);
  assert.equal(f.last(r).type, decision.type);
  assert.deepEqual(f.owner(), original);
});

test('canonical terminal proof retains terminal routing and never replays the run', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client(); f.command(a);
  f.snapshot(r, { requests: [{ ...recovery, status: 'completed' }] });
  assert.equal(f.owner().status, 'terminal');
  f.recovered(r, { approvals: [], finalState: { status: 'completed' } });
  assert.equal(f.last(a).body.finalState.status, 'completed');
  assert.equal(f.messages(r).some(body => body.type === 'run_request'), false);
});

test('a scope inserted while proof is pending cannot be overwritten by adoption', t => {
  const f = adoptionFixture(t), r = f.runtime(), a = f.client(); f.command(a);
  const original = f.store.create(f.identity({ requestId: recovery.requestId, sessionId: 'other-chat' }));
  f.snapshot(r);
  assert.equal(f.last(a).code, 'request_not_owned');
  assert.deepEqual(f.owner(), original);
  assert.equal(f.messages(r).some(body => body.type === recovery.type), false);
});
