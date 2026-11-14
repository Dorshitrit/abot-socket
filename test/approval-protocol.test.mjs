import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientCommand as normalize, expectedResponseType } from '../src/protocol/protocol.mjs';

const scope = { sessionId: 'chat-1', requestId: 'request-1' };
const decision = { type: 'request.approval.decide.request', ...scope,
  approvalId: 'approval:1', approved: true, generation: 'generation-1', waitId: 'wait-1', revision: 3,
  commandId: 'decision-1' };
const invalid = body => assert.throws(() => normalize(body), { code: 'invalid_command' });

test('approval recovery and complete decisions preserve explicit scope and receipt identity', () => {
  const recovery = { type: 'request.approvals.request', ...scope };
  assert.deepEqual(normalize(recovery), recovery);
  assert.deepEqual(normalize(decision), decision);
  assert.deepEqual(normalize({ ...decision, approved: false, reason: 'Not this operation' }),
    { ...decision, approved: false, reason: 'Not this operation' });
  assert.equal(expectedResponseType(recovery.type), 'request.approvals.response');
  assert.equal(expectedResponseType(decision.type), 'request.approval.decide.response');
});

test('legacy scoped decisions carry no invented durable receipt fields', () => {
  const legacy = { type: decision.type, ...scope, approvalId: decision.approvalId, approved: false };
  assert.deepEqual(normalize(legacy), legacy);
  for (const key of ['generation', 'waitId', 'revision', 'commandId']) {
    invalid({ ...legacy, [key]: decision[key] });
    const incomplete = { ...decision };
    delete incomplete[key];
    invalid(incomplete);
  }
});

test('approval transport rejects injected authority, correlation and unbounded identities', () => {
  for (const [key, value] of Object.entries({ correlationId: 'injected', ownerId: 'other', deviceId: 'other',
    continuation: {}, expiresAt: Number.MAX_SAFE_INTEGER, force: true, approvalMode: 'durable_v1' })) {
    invalid({ ...decision, [key]: value });
  }
  for (const key of ['sessionId', 'requestId', 'generation', 'waitId', 'commandId']) {
    for (const value of [null, '', '../outside', 'x'.repeat(129)]) invalid({ ...decision, [key]: value });
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '3']) invalid({ ...decision, revision });
  invalid({ ...decision, approved: 'true' });
  invalid({ type: 'request.approvals.request', ...scope, approved: true });
  const accessor = { ...decision };
  Object.defineProperty(accessor, 'commandId', { enumerable: true, get() { assert.fail('Accessor executed'); } });
  invalid(accessor);
});

test('durable execution remains an explicit opt-in without changing permission ceilings', () => {
  const run = { type: 'run_request', ...scope, text: 'Hello' };
  assert.equal(Object.hasOwn(normalize(run), 'approvalMode'), false);
  assert.deepEqual(normalize({ ...run, approvalMode: 'durable_v1' }),
    { ...run, approvalMode: 'durable_v1', toolPermissionMode: 'ask' });
  for (const approvalMode of [null, true, 'durable', 'legacy', {}]) invalid({ ...run, approvalMode });
  assert.throws(() => normalize({ ...run, approvalMode: 'durable_v1', toolPermissionMode: 'full_plus' }),
    { code: 'forbidden' });
});
