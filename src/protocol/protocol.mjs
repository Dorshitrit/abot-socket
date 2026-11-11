import { Buffer } from 'node:buffer';
import {
  MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, fail, record, string, id, approvalId, integer,
  boolean, optional, attachment, attachments, modelPreference, reasoningPreference, upload,
} from './protocol-validation.mjs';

export { MAX_MESSAGE_BYTES, MAX_ATTACHMENT_BYTES, MAX_TEXT_BYTES } from './protocol-validation.mjs';

const FIELDS = Object.freeze({
  run_request: ['requestId', 'sessionId', 'input', 'text', 'agentMode', 'modelPreference', 'reasoningPreference', 'toolPermissionMode', 'attachments'],
  steer_request: ['requestId', 'steerId', 'text'],
  tool_approval_response: ['approvalId', 'approved', 'reason'],
  'request.events.request': ['requestId', 'afterSeq'],
  'session.list.request': ['limit', 'cursor'],
  'session.snapshot.request': ['sessionId', 'afterMessageId', 'includeRequests'],
  'session.delete.request': ['sessionId'],
  'session.messages.clear.request': ['sessionId'],
  'session.message.delete.request': ['sessionId', 'messageId'],
  'attachment.upload.request': ['sessionId', 'requestId', 'mimeType', 'kind', 'name', 'data'],
  'attachment.fetch.request': ['sessionId', 'attachment'],
  subscribe_request: ['requestId'],
});
const RESPONSES = Object.freeze({
  'request.events.request': 'request.events.response',
  'session.list.request': 'session.list.response',
  'session.snapshot.request': 'session.snapshot.response',
  'session.delete.request': 'session.delete.response',
  'session.messages.clear.request': 'session.messages.clear.response',
  'session.message.delete.request': 'session.message.delete.response',
  'attachment.upload.request': 'attachment.upload.response',
  'attachment.fetch.request': 'attachment.fetch.response',
});
const MODES = ['ask', 'full_access', 'full_plus'];
const text = (value) => string(value, MAX_TEXT_BYTES, { controls: true });

export function expectedResponseType(type) {
  return typeof type === 'string' && Object.hasOwn(RESPONSES, type) ? RESPONSES[type] : undefined;
}

function run(value, allowedModes) {
  const result = { type: value.type, requestId: id(value.requestId), sessionId: id(value.sessionId) };
  if (!Object.hasOwn(value, 'input') && !Object.hasOwn(value, 'text')) fail();
  optional(value, result, 'input', text);
  optional(value, result, 'text', text);
  optional(value, result, 'agentMode', (mode) => {
    if (!['fast', 'reasoning', 'deep'].includes(mode)) fail();
    return mode;
  });
  optional(value, result, 'modelPreference', modelPreference);
  optional(value, result, 'reasoningPreference', reasoningPreference);
  const mode = Object.hasOwn(value, 'toolPermissionMode') ? value.toolPermissionMode : 'ask';
  if (!MODES.includes(mode)) fail();
  if (!Array.isArray(allowedModes) || !allowedModes.includes(mode)) fail('forbidden');
  result.toolPermissionMode = mode;
  optional(value, result, 'attachments', attachments);
  return result;
}

function normalize(value, allowedModes) {
  const result = { type: value.type };
  switch (value.type) {
    case 'run_request': return run(value, allowedModes);
    case 'subscribe_request': return { ...result, requestId: id(value.requestId) };
    case 'steer_request': return { ...result, requestId: id(value.requestId), steerId: id(value.steerId), text: text(value.text) };
    case 'tool_approval_response':
      result.approvalId = approvalId(value.approvalId);
      result.approved = boolean(value.approved);
      optional(value, result, 'reason', text);
      return result;
    case 'request.events.request':
      result.requestId = id(value.requestId);
      optional(value, result, 'afterSeq', (seq) => integer(seq));
      return result;
    case 'session.list.request':
      optional(value, result, 'limit', (limit) => integer(limit, 1, 100));
      optional(value, result, 'cursor', (cursor) => cursor === null ? null : string(cursor, 4096));
      return result;
    case 'session.snapshot.request':
      result.sessionId = id(value.sessionId);
      optional(value, result, 'afterMessageId', (cursor) => cursor === null ? null : typeof cursor === 'number' ? integer(cursor) : id(cursor));
      optional(value, result, 'includeRequests', boolean);
      return result;
    case 'session.delete.request':
    case 'session.messages.clear.request':
      return { ...result, sessionId: id(value.sessionId) };
    case 'session.message.delete.request':
      return { ...result, sessionId: id(value.sessionId),
        messageId: typeof value.messageId === 'number' ? String(integer(value.messageId)) : id(value.messageId) };
    case 'attachment.upload.request': return upload(value);
    case 'attachment.fetch.request': return { ...result, sessionId: id(value.sessionId), attachment: attachment(value.attachment) };
    default: return fail('unsupported');
  }
}

/** Validate client-owned fields only; the relay adds its private correlation ID. */
export function normalizeClientCommand(body, allowedModes = ['ask']) {
  // Validate descriptors before reading even the command type.
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  const descriptor = Object.getOwnPropertyDescriptor(body, 'type');
  if (!descriptor || !('value' in descriptor)) fail();
  const type = string(descriptor.value, 80);
  if (!Object.hasOwn(FIELDS, type)) {
    if (/^(?:runtime\.|admin\.|cron\.|schedule\.|session\.(?:delete|messages\.clear|message\.delete)\.)/u.test(type)) fail('forbidden');
    fail('unsupported');
  }
  record(body, ['type', ...FIELDS[type]]);
  const result = normalize(body, allowedModes);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_MESSAGE_BYTES) fail();
  return result;
}
