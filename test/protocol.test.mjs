import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientCommand as normalize, expectedResponseType, MAX_ATTACHMENT_BYTES, MAX_TEXT_BYTES } from '../src/protocol/protocol.mjs';

const run = { type: 'run_request', requestId: 'request-1', sessionId: 'session-1', text: 'שלום\nHello' };
const reference = { id: 'att-1', kind: 'image', mimeType: 'image/png', storageRef: 'session-1/upload-1/att-1.png', name: 'photo.png', size: 5 };
const invalid = (body, code = 'invalid_command', modes) => assert.throws(() => normalize(body, modes), { code });

test('retains the runtime fixture and defaults to ask without mutating input', () => {
  const fixture = { ...run, agentMode: 'reasoning', modelPreference: { profileId: 'provider/model-q4', scope: 'main' }, reasoningPreference: { profileId: 'provider/model-q4', mode: 'budget', budgetTokens: 2048 }, attachments: [reference] };
  const normalized = normalize(fixture);
  assert.deepEqual(normalized, { ...fixture, toolPermissionMode: 'ask' });
  assert.notEqual(normalized, fixture);
  assert.notEqual(normalized.attachments[0], reference);
  assert.equal(Object.hasOwn(fixture, 'toolPermissionMode'), false);
  assert.deepEqual(normalize({ ...run, input: 'Preferred input' }), { ...run, input: 'Preferred input', toolPermissionMode: 'ask' });
});

test('rejects command privilege injection and unknown fields', () => {
  for (const [key, value] of Object.entries({ correlationId: 'mine', agentId: 'prod', environment: 'prod', schedule: {}, runMetadata: {}, durableApprovals: true, abortSignal: {}, onAccepted: true })) invalid({ ...run, [key]: value });
  for (const type of ['runtime.config.patch', 'runtime.restart.request', 'admin.status', 'cron.create', 'session.delete.all', 'session.messages.clear.all', 'session.message.delete.all']) invalid({ type }, 'forbidden');
  for (const type of ['cancel_request', 'request.cancel', 'resume_request', 'register', '__proto__']) invalid({ type }, 'unsupported');
  assert.equal(expectedResponseType('__proto__'), undefined);
});

test('session mutations expose only canonical session and message identities', () => {
  for (const name of ['session.delete', 'session.messages.clear', 'session.message.delete']) {
    const command = { type: `${name}.request`, sessionId: 'chat-1',
      ...(name === 'session.message.delete' ? { messageId: 'msg-3' } : {}) };
    assert.deepEqual(normalize(command), command);
    assert.equal(expectedResponseType(command.type), `${name}.response`);
    invalid({ type: command.type });
    for (const sessionId of ['', '../other', 7, 'a'.repeat(129)]) invalid({ ...command, sessionId });
    for (const [key, value] of Object.entries({ correlationId: 'mine', environment: 'prod', force: true,
      includeFiles: true, requestId: 'r', all: true })) invalid({ ...command, [key]: value });
  }
  const command = { type: 'session.message.delete.request', sessionId: 'chat-1', messageId: 3 };
  assert.deepEqual(normalize(command), { ...command, messageId: '3' });
  for (const messageId of [undefined, null, '', '../3', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid({ ...command, messageId });
  }
});

test('rejects inherited fields, accessors, symbols, non-records and sparse arrays', () => {
  for (const body of [null, [], 'text', 1, new Date(), Object.assign(Object.create({ environment: 'prod' }), run)]) invalid(body);
  const accessor = { ...run };
  Object.defineProperty(accessor, 'text', { get() { assert.fail('getter was executed'); }, enumerable: true });
  invalid(accessor);
  const preference = { profileId: 'p' };
  Object.defineProperty(preference, 'mode', { get() { assert.fail('nested getter was executed'); }, enumerable: true });
  invalid({ ...run, reasoningPreference: preference });
  invalid({ ...run, [Symbol('secret')]: true });
  invalid(JSON.parse('{"type":"run_request","requestId":"r","sessionId":"s","text":"x","__proto__":{}}'));
  invalid({ ...run, attachments: Array(1) });
  invalid({ ...run, attachments: Object.assign([reference], { extra: true }) });
});

test('requires safe IDs and nonempty bounded UTF-8 text', () => {
  for (const requestId of ['', 'a'.repeat(129), 'a/b', 'a\nb', 4, null]) invalid({ ...run, requestId });
  for (const text of ['', '   ', null, 17, 'x'.repeat(MAX_TEXT_BYTES + 1), 'א'.repeat(MAX_TEXT_BYTES / 2 + 1)]) invalid({ ...run, text });
  invalid({ ...run, input: '' });
  const { text: omitted, ...withoutText } = run;
  invalid(withoutText);
  invalid({ ...run, sessionId: undefined });
  assert.equal(normalize({ ...run, text: 'x'.repeat(MAX_TEXT_BYTES) }).text.length, MAX_TEXT_BYTES);
  assert.equal(normalize({ ...run, requestId: 'r.dev:1_A-2' }).requestId, 'r.dev:1_A-2');
});

test('permission ceiling cannot be raised by body or model preferences', () => {
  invalid({ ...run, toolPermissionMode: 'full_access' }, 'forbidden');
  invalid({ ...run, toolPermissionMode: 'full_plus' }, 'forbidden', ['ask', 'full_access']);
  for (const mode of ['full', 'ASK', null, 1]) invalid({ ...run, toolPermissionMode: mode });
  assert.equal(normalize({ ...run, toolPermissionMode: 'full_plus' }, ['ask', 'full_plus']).toolPermissionMode, 'full_plus');
  for (const modelPreference of [{}, { profileId: 'p', scope: 'root' }, { profileId: 'p', apiKey: 'x' }, { profileId: 'p', toolPermissionMode: 'full_plus' }]) invalid({ ...run, modelPreference });
  for (const scope of ['main', 'all']) assert.deepEqual(normalize({ ...run, modelPreference: { profileId: 'p', scope } }).modelPreference, { profileId: 'p', scope });
});

test('accepts only the existing profile-bound reasoning preference contract', () => {
  for (const mode of ['off', 'server-default']) assert.deepEqual(normalize({ ...run, reasoningPreference: { profileId: 'p', mode } }).reasoningPreference, { profileId: 'p', mode });
  for (const budgetTokens of [0, 2_147_483_647]) assert.equal(normalize({ ...run, reasoningPreference: { profileId: 'p', mode: 'budget', budgetTokens } }).reasoningPreference.budgetTokens, budgetTokens);
  for (const reasoningPreference of [{ mode: 'off' }, { profileId: 'p', mode: 'off', budgetTokens: 0 }, { profileId: 'p', mode: 'budget', budgetTokens: -1 }, { profileId: 'p', mode: 'budget', budgetTokens: 2_147_483_648 }, { profileId: 'p', mode: 'budget', budgetTokens: NaN }, { profileId: 'p', mode: 'high' }]) invalid({ ...run, reasoningPreference });
});

test('RPC mappings and strict replay/pagination parameters preserve wire contracts', () => {
  for (const name of ['request.events', 'session.list', 'session.snapshot', 'attachment.upload', 'attachment.fetch']) assert.equal(expectedResponseType(`${name}.request`), `${name}.response`);
  for (const type of ['run_request', 'steer_request', 'tool_approval_response', 'subscribe_request']) assert.equal(expectedResponseType(type), undefined);
  assert.deepEqual(normalize({ type: 'request.events.request', requestId: 'r', afterSeq: 0 }), { type: 'request.events.request', requestId: 'r', afterSeq: 0 });
  for (const afterSeq of [-1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) invalid({ type: 'request.events.request', requestId: 'r', afterSeq });
  for (const limit of [0, 101, 1.5, '10']) invalid({ type: 'session.list.request', limit });
  assert.deepEqual(normalize({ type: 'session.list.request', limit: 50, cursor: null }), { type: 'session.list.request', limit: 50, cursor: null });
  assert.deepEqual(normalize({ type: 'session.snapshot.request', sessionId: 's', afterMessageId: 3, includeRequests: true }), { type: 'session.snapshot.request', sessionId: 's', afterMessageId: 3, includeRequests: true });
  invalid({ type: 'session.snapshot.request', sessionId: 's', includeRequests: 'true' });
});

test('steering, subscription and live approvals have distinct minimum fields', () => {
  const steer = { type: 'steer_request', requestId: 'r', steerId: 'steer-1', text: 'Continue briefly' };
  assert.deepEqual(normalize(steer), steer);
  invalid({ ...steer, steerId: undefined });
  assert.deepEqual(normalize({ type: 'subscribe_request', requestId: 'r' }), { type: 'subscribe_request', requestId: 'r' });
  const approval = { type: 'tool_approval_response', approvalId: 'approval-1', approved: false, reason: 'Declined' };
  assert.deepEqual(normalize(approval), approval);
  invalid({ ...approval, approved: 'false' });
  invalid({ ...approval, sessionId: 's' });
});

test('runtime approval suffix fits without widening client request IDs', () => {
  const requestId = 'r'.repeat(128);
  const approval = { type: 'tool_approval_response', approvalId: `${requestId}:approval:1`, approved: true };
  assert.deepEqual(normalize(approval), approval);
  assert.equal(normalize({ ...approval, approvalId: 'a'.repeat(512) }).approvalId.length, 512);
  for (const approvalId of ['a'.repeat(513), '', 'approval/path', 'approval\n1']) invalid({ ...approval, approvalId });
  invalid({ ...run, requestId: `${requestId}:approval:1` });
});

test('canonical base64 upload and reference fetch match existing attachment fixtures', () => {
  const upload = { type: 'attachment.upload.request', sessionId: 's', requestId: 'r', mimeType: 'image/png', name: 'photo.png', data: Buffer.from('image').toString('base64') };
  assert.deepEqual(normalize(upload), upload);
  const fetch = { type: 'attachment.fetch.request', sessionId: 's', attachment: reference };
  assert.deepEqual(normalize(fetch), fetch);
  for (const data of ['', 'a', '!!!!', 'aW1hZ2U', 'aW1hZ2U=\n', 'Zh==', 'data:image/png;base64,YQ==']) invalid({ ...upload, data });
  invalid({ ...upload, kind: 'file' });
  invalid({ ...upload, mimeType: 'text/html' });
  invalid({ ...fetch, attachment: { ...reference, absolutePath: '/secret' } });
  invalid({ ...fetch, attachment: { ...reference, size: -1 } });
  invalid({ ...run, attachments: Array.from({ length: 33 }, () => reference) });
});

test('rejects uploads over the decoded limit, including padded boundary cases', () => {
  const upload = { type: 'attachment.upload.request', sessionId: 's', mimeType: 'application/pdf' };
  const maximum = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
  assert.equal(normalize({ ...upload, data: maximum }).data.length, maximum.length);
  invalid({ ...upload, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') });
  invalid({ ...upload, data: 'A'.repeat(16 * 1024 * 1024 + 4) });
});
