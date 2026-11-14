import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalTransportFixture, savedApprovalResponse } from './approval-transport-fixture.mjs';

test('paired client can recover computer work after exact runtime proof over the authenticated transport', async t => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair();
  const client = await f.client(login.token), runtime = await f.runtime();
  const scope = { sessionId: 'computer-session', requestId: 'computer-request' };
  const id = f.command(client, { type: 'request.approvals.request', ...scope });
  const proof = await runtime.next(frame => frame.type === 'session.snapshot.request');
  assert.equal(proof.sessionId, scope.sessionId);
  runtime.send({ type: 'session.snapshot.response', correlationId: proof.correlationId,
    sessionId: scope.sessionId, ok: true, requests: [{ ...scope, status: 'awaiting_approval' }], nextCursor: null });
  const query = await runtime.next(frame => frame.type === 'request.approvals.request');
  runtime.send(savedApprovalResponse(query));
  const response = await client.next(frame => frame.id === id);
  const approval = response.body.approvals[0];
  const decideId = f.command(client, { type: 'request.approval.decide.request', ...scope,
    approvalId: approval.request.approvalId, approved: true, ...approval.wait, commandId: 'decision-1' });
  const decision = await runtime.next(frame => frame.type === 'request.approval.decide.request');
  assert.equal(decision.revision, approval.wait.revision);
  runtime.send({ type: 'request.approval.decide.response', correlationId: decision.correlationId,
    ...scope, ok: true, result: { accepted: true } });
  assert.equal((await client.next(frame => frame.id === decideId)).body.result.accepted, true);
  assert.equal(runtime.received.some(frame => frame.type === 'run_request'), false);
});
