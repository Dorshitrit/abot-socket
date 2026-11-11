import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeGrants, resolveRuntimeCredential, digestToken } from '../src/auth/runtime-credentials.mjs';
import { WindowLimiter } from '../src/transport/transport-limits.mjs';

test('runtime credentials bind to one identity and reject duplicated grants', () => {
  const token = 'x'.repeat(64);
  const grant = { runtimeId: 'test-runtime', tokenSha256: digestToken(token) };
  const grants = validateRuntimeGrants([grant]);
  assert.equal(resolveRuntimeCredential(`Bearer ${token}`, grants).runtimeId, 'test-runtime');
  assert.equal(resolveRuntimeCredential(`Bearer ${'y'.repeat(64)}`, grants), null);
  assert.equal(resolveRuntimeCredential('Bearer short', grants), null);
  assert.throws(() => validateRuntimeGrants([grant, { ...grant, runtimeId: 'other' }]));
  assert.throws(() => validateRuntimeGrants([{ ...grant, allowedModes: ['unknown'] }]));
});

test('bounded limiter fails closed at capacity and reopens only expired windows', () => {
  let now = 100;
  const limiter = new WindowLimiter({ limit: 1, windowMs: 100, capacity: 1, now: () => now });
  assert.equal(limiter.allow('first'), true);
  assert.equal(limiter.allow('first'), false);
  assert.equal(limiter.allow('second'), false);
  now = 200;
  assert.equal(limiter.allow('second'), true);
});
