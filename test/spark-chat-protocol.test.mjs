import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientCommand, expectedResponseType } from '../src/protocol/protocol.mjs';
import { SPARK_SESSION_ID, projectSparkOpenResponse } from '../src/protocol/spark-chat-protocol.mjs';

const open = { type: 'spark.chat.open.request' };
const success = (fields = {}) => ({
  type: 'spark.chat.open.response', correlationId: 'relay-correlation', ok: true,
  sessionId: SPARK_SESSION_ID, modelProfileId: 'provider/spark',
  toolPermissionMode: 'ask', readiness: 'ready', ...fields,
});

test('SPARK open has no client-selected configuration or correlation fields', () => {
  assert.deepEqual(normalizeClientCommand(open), open);
  assert.equal(expectedResponseType(open.type), 'spark.chat.open.response');
  for (const [field, value] of Object.entries({
    sessionId: 'other', modelProfileId: 'other', toolPermissionMode: 'full_plus',
    correlationId: 'client-controlled', environment: 'other', preferences: {},
    requestId: 'request', force: true,
  })) {
    assert.throws(() => normalizeClientCommand({ ...open, [field]: value }), { code: 'invalid_command' });
  }
  for (const type of ['spark.chat.configure.request', 'spark.chat.clear.request', 'spark.jobs.request']) {
    assert.throws(() => normalizeClientCommand({ type }), { code: 'unsupported' });
  }
  assert.throws(() => normalizeClientCommand(Object.assign(Object.create({ sessionId: 'other' }), open)));
  const accessor = { ...open };
  Object.defineProperty(accessor, 'sessionId', {
    enumerable: true, get() { assert.fail('client accessor must not execute'); },
  });
  assert.throws(() => normalizeClientCommand(accessor), { code: 'invalid_command' });
});

test('successful replies project only the bounded public chat state without mutating source', () => {
  const source = success({ preferences: { secret: 'private-value' },
    snapshot: { messages: ['private transcript'] }, apiKey: 'private-key' });
  const before = structuredClone(source);
  assert.deepEqual(projectSparkOpenResponse(source), success());
  assert.deepEqual(source, before);
  for (const toolPermissionMode of ['ask', 'full_access', 'full_plus']) {
    assert.equal(projectSparkOpenResponse(success({ toolPermissionMode })).toolPermissionMode, toolPermissionMode);
  }
  assert.deepEqual(projectSparkOpenResponse(success({ readiness: 'model_required', modelProfileId: null })),
    success({ readiness: 'model_required', modelProfileId: null }));
  assert.deepEqual(projectSparkOpenResponse(success({ readiness: 'model_unavailable' })),
    success({ readiness: 'model_unavailable' }));
  assert.equal(projectSparkOpenResponse(success({ modelProfileId: 'a'.repeat(256) })).modelProfileId.length, 256);
});

test('malformed, inconsistent or over-limit success states are not projected', () => {
  for (const source of [
    null, [], 'text', {}, success({ type: 'session.snapshot.response' }), success({ ok: 1 }),
    success({ sessionId: 'another-session' }), success({ sessionId: undefined }),
    success({ correlationId: undefined }), success({ correlationId: 'bad/path' }),
    success({ modelProfileId: '' }), success({ modelProfileId: '   ' }),
    success({ modelProfileId: 'line\nbreak' }), success({ modelProfileId: 'a'.repeat(257) }),
    success({ modelProfileId: 'א'.repeat(129) }), success({ modelProfileId: {} }),
    success({ modelProfileId: null }), success({ modelProfileId: undefined }),
    success({ readiness: 'unknown' }), success({ readiness: 'model_required' }),
    success({ readiness: 'model_unavailable', modelProfileId: null }),
    success({ toolPermissionMode: 'full' }), success({ toolPermissionMode: undefined }),
  ]) assert.equal(projectSparkOpenResponse(source), null);
});

test('failure replies carry known public codes and never arbitrary diagnostics', () => {
  for (const error of [
    'spark_chat_session_unavailable', 'spark_chat_model_required', 'spark_chat_model_unavailable',
    'spark_chat_permission_mismatch', 'spark_chat_unsupported', 'spark_chat_unavailable',
    'invalid_spark_chat_request',
  ]) {
    const publicReply = { type: 'spark.chat.open.response', correlationId: 'relay-correlation', ok: false, error };
    assert.deepEqual(projectSparkOpenResponse({ ...publicReply,
      message: 'private path', diagnostics: { token: 'private token' }, preferences: {},
    }), publicReply);
  }
  for (const error of ['private filesystem failure', '', null, {}, 'x'.repeat(1000)]) {
    assert.equal(projectSparkOpenResponse({
      type: 'spark.chat.open.response', correlationId: 'relay-correlation', ok: false, error,
    }), null);
  }
});
