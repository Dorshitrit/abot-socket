import { isRelayId } from '../relay/relay-runtime-registration.mjs';
import { hasPreviewKey } from './notification-preview-crypto.mjs';

export function notificationInputError(code = 'invalid_request', status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function exactRecord(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw notificationInputError();
  if (Object.keys(value).some(key => !allowed.includes(key))) throw notificationInputError();
}

export function notificationReadIds(value) {
  exactRecord(value, ['ids']);
  if (!Array.isArray(value.ids) || value.ids.length > 100 || !value.ids.every(isRelayId)) {
    throw notificationInputError();
  }
  return [...new Set(value.ids)];
}

export function notificationPresence(value, allowedRuntimeIds) {
  exactRecord(value, ['foreground', 'runtimeId', 'sessionId']);
  if (typeof value.foreground !== 'boolean') throw notificationInputError();
  for (const key of ['runtimeId', 'sessionId']) {
    if (value[key] !== undefined && !isRelayId(value[key])) throw notificationInputError();
  }
  if (value.sessionId !== undefined && value.runtimeId === undefined) throw notificationInputError();
  if (value.runtimeId !== undefined && !allowedRuntimeIds.includes(value.runtimeId)) {
    throw notificationInputError('forbidden', 403);
  }
  return value.foreground ? { ...value } : { foreground: false };
}

function boundedCredential(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !/[\s\x00-\x1f\x7f]/u.test(value);
}

export function notificationRegistration(value) {
  if (value?.provider === 'fcm') {
    exactRecord(value, ['provider', 'token']);
    if (!boundedCredential(value.token, 4096)) throw notificationInputError();
    return { provider: 'fcm', token: value.token };
  }
  if (value?.provider === 'gateway') {
    exactRecord(value, ['provider', 'endpointId', 'sendToken']);
    if (!boundedCredential(value.endpointId, 256) || !boundedCredential(value.sendToken, 2048)) {
      throw notificationInputError();
    }
    return { provider: 'gateway', endpointId: value.endpointId, sendToken: value.sendToken };
  }
  throw notificationInputError();
}

export function notificationPreviewKey(value) {
  if (!hasPreviewKey(value)) throw notificationInputError();
  return { keyId: value.keyId, key: value.key };
}

export function notificationListOptions(params) {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['limit', 'before'].includes(key))) {
    throw notificationInputError();
  }
  const limitValue = params.get('limit') ?? '50';
  if (!/^\d{1,3}$/.test(limitValue)) throw notificationInputError();
  const limit = Number(limitValue);
  if (limit < 1 || limit > 100) throw notificationInputError();
  const cursor = params.get('before');
  if (cursor === null) return { limit, before: null };
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw notificationInputError();
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) ||
      value[0] < 0 || !isRelayId(value[1])) throw new Error();
    return { limit, before: { createdAt: value[0], id: value[1] } };
  } catch { throw notificationInputError(); }
}

export function notificationCursor(item) {
  return Buffer.from(JSON.stringify([item.createdAt, item.id])).toString('base64url');
}
