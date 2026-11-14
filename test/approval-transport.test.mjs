import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalTransportFixture, savedApprovalResponse } from './approval-transport-fixture.mjs';
import { clientCapabilities } from '../src/cli/client-capabilities.mjs';

const SCOPE = { requestId: 'saved-request', sessionId: 'saved-session' };

async function dispatchOwnedRequest(f, client, runtime, { durable = true, scope = SCOPE } = {}) {
  const id = f.command(client, { type: 'run_request', ...scope, text: 'Perform the scripted fixture action.',
    ...(durable ? { approvalMode: 'durable_v1' } : {}) });
  const command = await runtime.next(frame => frame.type === 'run_request');
  assert.equal((await client.next(frame => frame.id === id)).type, 'relay.ack');
  return command;
}

async function recoverApproval(f, client, runtime, scope = SCOPE) {
  const id = f.command(client, { type: 'request.approvals.request', ...scope });
  const query = await runtime.next(frame => frame.type === 'request.approvals.request');
  assert.notEqual(query.correlationId, id);
  const canonical = savedApprovalResponse(query);
  runtime.send(canonical);
  const response = await client.next(frame => frame.id === id);
  assert.equal(response.type, 'relay.response');
  assert.deepEqual(response.body, canonical);
  return canonical;
}

test('server capabilities describe API support separately from each online runtime', async (t) => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair();
  const client = await f.client(login.token);
  assert.equal(client.authenticated.capabilities.durableApprovals, true);
  assert.equal(client.authenticated.capabilities.cancel, false);
  assert.equal(client.authenticated.capabilities.sessionMutation, true);
  assert.equal(client.authenticated.capabilities.notifications, true);
  assert.equal(clientCapabilities().durableApprovals, false);
  const offline = await f.request('/v2/runtimes', { token: login.token });
  assert.ok(offline.body.runtimes.every(runtime => runtime.capabilities.durableApprovals === false));
  const legacy = await f.runtime('alpha', []);
  await f.runtime('beta');
  const catalog = await f.request('/v2/runtimes', { token: login.token });
  assert.deepEqual(catalog.body.runtimes.map(runtime => [runtime.runtimeId, runtime.capabilities.durableApprovals]),
    [['alpha', false], ['beta', true]]);

  const unsupported = f.command(client, { type: 'run_request', ...SCOPE, text: 'Fixture', approvalMode: 'durable_v1' });
  assert.equal((await client.next(frame => frame.id === unsupported)).code, 'approvals_unsupported');
  assert.equal(legacy.received.some(frame => frame.type === 'run_request'), false);
  const ordinary = await dispatchOwnedRequest(f, client, legacy, { durable: false });
  assert.equal(Object.hasOwn(ordinary, 'approvalMode'), false);
  legacy.send({ type: 'event', name: 'tool.approval.required', ...SCOPE, approvalId: 'legacy-approval' });
  await client.next(frame => frame.type === 'relay.event' && frame.body.approvalId === 'legacy-approval');
  const id = f.command(client, { type: 'tool_approval_response', approvalId: 'legacy-approval', approved: true });
  assert.equal((await legacy.next(frame => frame.type === 'tool_approval_response')).approved, true);
  assert.equal((await client.next(frame => frame.id === id)).type, 'relay.ack');
});

test('persistent ownership survives server restart and original-device revocation for a freshly paired owner device', async (t) => {
  const f = await approvalTransportFixture(t);
  const original = await f.pair('Original test phone');
  const originalClient = await f.client(original.token);
  const initialRuntime = await f.runtime();
  assert.equal((await dispatchOwnedRequest(f, originalClient, initialRuntime)).approvalMode, 'durable_v1');
  initialRuntime.send({ type: 'event', name: 'tool.approval.required', ...SCOPE, approvalId: 'fixture-approval' });
  await originalClient.next(frame => frame.type === 'relay.event');

  await f.restart();
  const replacement = await f.pair('Replacement test phone');
  const revoke = await f.request(`/v2/auth/sessions/${original.session.id}`, {
    token: replacement.token, method: 'DELETE',
  });
  assert.deepEqual(revoke.body, { revoked: true });
  assert.equal((await f.request('/v2/runtimes', { token: original.token })).status, 401);
  await assert.rejects(f.client(original.token));
  const client = await f.client(replacement.token);
  const runtime = await f.runtime();
  const canonical = await recoverApproval(f, client, runtime);
  const pending = canonical.approvals[0];
  const decision = { type: 'request.approval.decide.request', ...SCOPE,
    approvalId: pending.request.approvalId, ...pending.wait, commandId: 'stable-approval-command', approved: true };
  const id = f.command(client, decision);
  const received = await runtime.next(frame => frame.type === decision.type);
  const { correlationId, ...forwarded } = received;
  assert.deepEqual(forwarded, decision);
  runtime.send({ type: 'request.approval.decide.response', correlationId, ...SCOPE,
    ok: true, result: { accepted: true } });
  assert.deepEqual((await client.next(frame => frame.id === id)).body.result, { accepted: true });
  runtime.send({ type: 'completed', ...SCOPE, output: 'Scripted completed response' });
  const completed = await client.next(frame => frame.type === 'relay.event' && frame.body.type === 'completed');
  assert.equal(completed.body.output, 'Scripted completed response');
});

test('historical approval events never create ownership and recovery is isolated by runtime and session', async (t) => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair();
  const client = await f.client(login.token);
  const runtime = await f.runtime();
  const otherRuntime = await f.runtime('beta');
  await dispatchOwnedRequest(f, client, runtime);
  const replayId = f.command(client, { type: 'request.events.request', requestId: 'historical-request' });
  const replay = await runtime.next(frame => frame.type === 'request.events.request');
  runtime.send({ type: 'request.events.response', correlationId: replay.correlationId,
    requestId: replay.requestId, ok: true, finalState: null,
    events: [{ type: 'event', name: 'tool.approval.required', requestId: replay.requestId, approvalId: 'historical-approval' }] });
  assert.equal((await client.next(frame => frame.id === replayId)).type, 'relay.response');
  for (const [runtimeId, scope] of [
    ['alpha', { ...SCOPE, requestId: 'historical-request' }],
    ['alpha', { ...SCOPE, sessionId: 'other-session' }],
    ['beta', SCOPE],
  ]) {
    const id = f.command(client, { type: 'request.approvals.request', ...scope }, runtimeId);
    if (scope.sessionId === 'other-session') {
      assert.equal((await client.next(frame => frame.id === id)).code, 'request_not_owned');
      continue;
    }
    const peer = runtimeId === 'alpha' ? runtime : otherRuntime;
    const proof = await peer.next(frame => frame.type === 'session.snapshot.request');
    peer.send({ type: 'session.snapshot.response', correlationId: proof.correlationId,
      sessionId: scope.sessionId, ok: true, requests: [], nextCursor: null });
    assert.equal((await client.next(frame => frame.id === id)).code, 'request_scope_unverified');
  }
  assert.equal(runtime.received.some(frame => frame.type === 'request.approvals.request'), false);
  assert.equal(otherRuntime.received.some(frame => frame.type === 'request.approvals.request'), false);
  const foreign = await approvalTransportFixture(t);
  const foreignLogin = await foreign.pair();
  await assert.rejects(f.client(foreignLogin.token));
});

test('replacement runtime cannot answer an earlier correlation or change the recovered request scope', async (t) => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair();
  const client = await f.client(login.token);
  const previous = await f.runtime();
  await dispatchOwnedRequest(f, client, previous);
  const staleId = f.command(client, { type: 'request.approvals.request', ...SCOPE });
  const staleQuery = await previous.next(frame => frame.type === 'request.approvals.request');
  previous.socket.close();
  await previous.closed;
  assert.equal((await client.next(frame => frame.id === staleId)).code, 'outcome_unknown');
  const replacement = await f.runtime();
  const id = f.command(client, { type: 'request.approvals.request', ...SCOPE });
  const query = await replacement.next(frame => frame.type === 'request.approvals.request');
  assert.notEqual(query.correlationId, staleQuery.correlationId);
  replacement.send(savedApprovalResponse(staleQuery));
  replacement.send({ ...savedApprovalResponse(query), sessionId: 'wrong-session' });
  replacement.send({ ...savedApprovalResponse(query), requestId: 'wrong-request' });
  const correct = savedApprovalResponse(query);
  replacement.send(correct);
  const response = await client.next(frame => frame.id === id);
  assert.equal(response.type, 'relay.response');
  assert.deepEqual(response.body, correct);
  assert.equal(client.received.filter(frame => frame.id === staleId && frame.type === 'relay.response').length, 0);
  assert.equal(client.received.filter(frame => frame.id === id && frame.type === 'relay.response').length, 1);
});
