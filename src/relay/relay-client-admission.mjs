import { isRecord, isRelayId, relayError } from './relay-runtime-registration.mjs';

const MAX_COMMANDS = 512;
const COMMANDS_PER_MINUTE = 60;

export function createRelayClient(peer, identity, now) {
  if (!isRecord(identity) || typeof identity.subject !== 'string' || identity.subject.length > 320 || !identity.subject) {
    throw relayError('invalid_client_identity');
  }
  if (typeof identity.sessionId !== 'string' || !identity.sessionId || identity.sessionId.length > 256) {
    throw relayError('invalid_client_identity');
  }
  if (!Array.isArray(identity.allowedRuntimeIds) || identity.allowedRuntimeIds.length > 32) {
    throw relayError('invalid_client_identity');
  }
  if (identity.allowedRuntimeIds.some(id => !isRelayId(id))) throw relayError('invalid_client_identity');
  return {
    peer, subject: identity.subject, sessionId: identity.sessionId,
    allowedRuntimeIds: new Set(identity.allowedRuntimeIds), commands: new Set(),
    rateStartedAt: now, rateCount: 0,
  };
}

export function admitRelayCommand(client, message, now) {
  // Charge failed commands too. Authentication and IP rate limits are transport-owned.
  if (now - client.rateStartedAt >= 60_000) {
    client.rateStartedAt = now;
    client.rateCount = 0;
  }
  client.rateCount += 1;
  if (client.rateCount > COMMANDS_PER_MINUTE) throw relayError('rate_limited');
  if (!isRecord(message) || !isRelayId(message.id) || !isRelayId(message.runtimeId)) {
    throw relayError('invalid_command_envelope');
  }
  if (!client.allowedRuntimeIds.has(message.runtimeId)) throw relayError('runtime_forbidden');
  if (client.commands.has(message.id)) throw relayError('duplicate_command');
  if (client.commands.size >= MAX_COMMANDS) throw relayError('command_capacity');
  // IDs are not evicted while a connection is alive; a retry never re-dispatches.
  client.commands.add(message.id);
}
