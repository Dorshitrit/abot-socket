import { Buffer } from 'node:buffer';

export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
const MIME_TYPES = new Map([
  ['image/png', 'image'], ['image/jpeg', 'image'], ['image/webp', 'image'],
  ['application/pdf', 'file'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file'],
  ['text/plain', 'file'], ['text/csv', 'file'], ['text/markdown', 'file'],
  ['application/json', 'file'], ['application/rtf', 'file'],
]);

export function fail(code = 'invalid_command') {
  throw Object.assign(new Error(code), { code });
}

export function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) fail();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || !descriptor.enumerable || !('value' in descriptor)) fail();
  }
  return value;
}

export function string(value, maximum, { nonempty = true, controls = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) fail();
  if (nonempty && !value.trim()) fail();
  if (!controls && /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}

export function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) fail();
  return value;
}

export function approvalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,512}$/u.test(value)) fail();
  return value;
}

export function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

export function boolean(value) {
  if (typeof value !== 'boolean') fail();
  return value;
}

export function optional(source, target, key, validate) {
  if (Object.hasOwn(source, key)) target[key] = validate(source[key]);
}

export function mime(value) {
  const normalized = string(value, 160).split(';', 1)[0].trim().toLowerCase();
  if (!MIME_TYPES.has(normalized)) fail();
  return normalized;
}

export function kind(value) {
  if (value !== 'image' && value !== 'file') fail();
  return value;
}

export function attachment(value) {
  record(value, ['id', 'kind', 'mimeType', 'storageRef', 'name', 'size']);
  const result = {
    id: id(value.id), kind: kind(value.kind), mimeType: mime(value.mimeType),
    storageRef: string(value.storageRef, 2048),
  };
  if (MIME_TYPES.get(result.mimeType) !== result.kind) fail();
  optional(value, result, 'name', (name) => string(name, 1024));
  optional(value, result, 'size', (size) => integer(size, 0, MAX_ATTACHMENT_BYTES));
  return result;
}

export function attachments(value) {
  if (!Array.isArray(value) || value.length > 32) fail();
  // Sparse arrays and custom/accessor properties are not a JSON attachment list.
  if (Object.getPrototypeOf(value) !== Array.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) fail();
  }
  return Array.from(value, attachment);
}

export function base64(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_BASE64_LENGTH) fail();
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== value) fail();
  return value;
}

export function modelPreference(value) {
  record(value, ['profileId', 'scope']);
  const result = { profileId: string(value.profileId, 256) };
  optional(value, result, 'scope', (scope) => {
    if (scope !== 'main' && scope !== 'all') fail();
    return scope;
  });
  return result;
}

export function reasoningPreference(value) {
  record(value, ['profileId', 'mode', 'budgetTokens']);
  const result = { profileId: string(value.profileId, 256), mode: value.mode };
  if (!['off', 'server-default', 'budget'].includes(value.mode)) fail();
  if (value.mode !== 'budget' && Object.hasOwn(value, 'budgetTokens')) fail();
  if (value.mode === 'budget') result.budgetTokens = integer(value.budgetTokens, 0, 2_147_483_647);
  return result;
}

export function upload(value) {
  const result = {
    type: value.type, sessionId: id(value.sessionId), mimeType: mime(value.mimeType),
    data: base64(value.data),
  };
  optional(value, result, 'requestId', id);
  optional(value, result, 'kind', kind);
  optional(value, result, 'name', (name) => string(name, 1024));
  if (result.kind && MIME_TYPES.get(result.mimeType) !== result.kind) fail();
  return result;
}
