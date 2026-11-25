import { isRecord } from '../relay/relay-runtime-registration.mjs';

export const AGENT_NOTIFICATIONS_FEATURE = 'agents_notifications_v1';
export const AGENT_NOTIFICATION_RETENTION_MS = 7 * 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const KEYS = new Set(['type', 'eventId', 'targetAgentId', 'missionId', 'messageId',
  'reason', 'createdAt', 'expiresAt', 'output']);
const REASONS = new Set(['reply', 'question', 'completed', 'result', 'exhausted', 'plan', 'attention']);

export function isAgentNotificationId(value, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return false;
  return !/[\x00-\x1f\x7f]/u.test(value);
}

/** Runtime identity is supplied by authenticated transport, never by this payload. */
export function parseAgentNotification(body, now) {
  if (!isRecord(body) || body.type !== 'agents.notification') return null;
  if (Object.keys(body).some(key => !KEYS.has(key))) return null;
  if (Buffer.byteLength(JSON.stringify(body)) > 24 * 1024) return null;
  if (typeof body.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(body.eventId)) return null;
  if (!isAgentNotificationId(body.targetAgentId) || !isAgentNotificationId(body.missionId)) return null;
  if (!REASONS.has(body.reason)) return null;
  if (body.messageId !== undefined && !isAgentNotificationId(body.messageId, 4096)) return null;
  if (body.reason !== 'attention' && body.messageId === undefined) return null;
  if (body.output !== undefined && (typeof body.output !== 'string' || [...body.output].length > 600)) return null;
  if (body.reason === 'attention' && body.output) return null;
  if (!Number.isSafeInteger(body.createdAt) || body.createdAt < 0) return null;
  if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt <= body.createdAt) return null;
  if (body.expiresAt - body.createdAt > AGENT_NOTIFICATION_RETENTION_MS) return null;
  if (body.createdAt > now + CLOCK_SKEW_MS) return null;
  return { eventId: body.eventId, agentId: body.targetAgentId, missionId: body.missionId,
    ...(body.messageId === undefined ? {} : { messageId: body.messageId }), reason: body.reason,
    createdAt: body.createdAt, expiresAt: body.expiresAt, ...(body.output === undefined ? {} : { output: body.output }) };
}

export function agentNotificationKind(reason) {
  return ['reply', 'completed', 'result'].includes(reason) ? 'completed' : 'failed';
}
