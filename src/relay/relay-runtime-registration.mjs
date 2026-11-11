import { parseRuntimeModelCatalog } from './relay-model-catalog.mjs';

const MODES = new Set(['ask', 'full_access', 'full_plus']);

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isRelayId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function relayError(code) {
  return Object.assign(new Error(code), { code });
}

export function isBoundedRuntimeFrame(body) {
  if (!isRecord(body) || typeof body.type !== 'string' || body.type.length > 128) return false;
  try {
    return Buffer.byteLength(JSON.stringify(body)) <= 16 * 1024 * 1024;
  } catch {
    return false;
  }
}

export function validateRuntimeGrant(grant) {
  if (!isRecord(grant) || !isRelayId(grant.runtimeId)) throw relayError('invalid_runtime_grant');
  const allowedModes = grant.allowedModes ?? ['ask'];
  if (!Array.isArray(allowedModes) || allowedModes.length === 0 || allowedModes.length > 3) {
    throw relayError('invalid_runtime_grant');
  }
  if (allowedModes.some(mode => !MODES.has(mode))) throw relayError('invalid_runtime_grant');
  return { runtimeId: grant.runtimeId, allowedModes: [...new Set(allowedModes)] };
}

function boundedLabel(value, length) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= length;
}

export function parseRuntimeRegistration(body, runtimeId) {
  if (body.type !== 'register' || body.agentId !== runtimeId) throw relayError('runtime_identity_mismatch');
  if (Buffer.byteLength(JSON.stringify(body)) > 128 * 1024) throw relayError('registration_too_large');
  const features = body.features ?? [];
  if (!Array.isArray(features) || features.length > 64) throw relayError('invalid_runtime_features');
  if (features.some(feature => !boundedLabel(feature, 128))) throw relayError('invalid_runtime_features');
  if (new Set(features).size !== features.length) throw relayError('invalid_runtime_features');
  const modelCatalog = body.modelCatalog === undefined ? null : parseRuntimeModelCatalog(body.modelCatalog);
  return { features: [...features], modelCatalog };
}
