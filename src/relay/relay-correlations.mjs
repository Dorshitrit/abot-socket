import { randomUUID } from 'node:crypto';
import { isRecord, relayError } from './relay-runtime-registration.mjs';

const MAX_PENDING = 128;
const RPC_TIMEOUT_MS = 30_000;

function steeringKey(runtime, body) {
  return JSON.stringify([runtime.generation, body.requestId, body.steerId]);
}

function matchesResponseIdentity(entry, body) {
  const command = entry.command;
  if (command.type === 'steer_request') {
    return body.requestId === command.requestId && body.steerId === command.steerId
      && typeof body.accepted === 'boolean';
  }
  if (typeof body.ok !== 'boolean') return false;
  if (command.type === 'request.events.request' && body.requestId !== command.requestId) return false;
  // Upload responses intentionally do not echo requestId in the existing runtime.
  if (body.requestId !== undefined && body.requestId !== command.requestId) return false;
  if (command.sessionId !== undefined && body.sessionId !== command.sessionId) return false;
  if (body.sessionId !== undefined && command.sessionId === undefined) return false;
  if (command.type === 'session.message.delete.request' && body.messageId !== command.messageId) return false;
  if (command.type === 'session.messages.clear.request' && typeof body.cleared !== 'boolean') return false;
  if (['session.delete.request', 'session.message.delete.request'].includes(command.type)
    && typeof body.deleted !== 'boolean') return false;
  if (command.type === 'request.events.request' && body.ok) {
    if (!Array.isArray(body.events) || body.events.length > 8192) return false;
    if (body.events.some(event => !isRecord(event) || (event.requestId !== undefined && event.requestId !== command.requestId))) return false;
  }
  return true;
}

export class RelayCorrelations {
  constructor({ now, respond, unknown }) {
    this.now = now;
    this.respond = respond;
    this.unknown = unknown;
    this.pending = new Map();
    this.steering = new Map();
  }

  create(client, runtime, id, command, expectedType, lifecycle = {}) {
    if (this.pending.size >= MAX_PENDING) throw relayError('pending_capacity');
    const steerKey = command.type === 'steer_request' ? steeringKey(runtime, command) : null;
    if (steerKey && this.steering.has(steerKey)) throw relayError('duplicate_steer_id');
    const correlationId = randomUUID();
    // Retain routing identity, never attachment bytes, prompts or conversation data.
    const identity = { type: command.type, requestId: command.requestId,
      sessionId: command.sessionId, steerId: command.steerId, messageId: command.messageId };
    const entry = { client, runtime, id, command: identity, expectedType, correlationId,
      expiresAt: this.now() + RPC_TIMEOUT_MS, steerKey, lifecycle };
    this.pending.set(correlationId, entry);
    if (steerKey) this.steering.set(steerKey, correlationId);
    return entry;
  }

  remove(entry) {
    this.pending.delete(entry.correlationId);
    if (entry.steerKey) this.steering.delete(entry.steerKey);
    entry.lifecycle.removed?.();
  }

  receive(runtime, body) {
    const correlationId = body.type === 'steer_ack'
      ? this.steering.get(steeringKey(runtime, body)) : body.correlationId;
    const entry = this.pending.get(correlationId);
    if (!entry || entry.runtime !== runtime || entry.expectedType !== body.type) return false;
    if (entry.expiresAt <= this.now() || !matchesResponseIdentity(entry, body)) return false;
    // An invalid reply must never consume the genuine request's pending record.
    this.remove(entry);
    (entry.lifecycle.respond ?? this.respond)(entry, body);
    return true;
  }

  fail(entry) {
    if (!this.pending.has(entry.correlationId)) return;
    this.remove(entry);
    (entry.lifecycle.unknown ?? this.unknown)(entry);
  }

  disconnectRuntime(runtime) {
    for (const entry of this.pending.values()) if (entry.runtime === runtime) this.fail(entry);
  }

  disconnectClient(client) {
    for (const entry of this.pending.values()) {
      if (entry.client !== client || entry.lifecycle.retainOnClientDisconnect) continue;
      this.remove(entry);
    }
  }

  prune() {
    for (const entry of this.pending.values()) if (entry.expiresAt <= this.now()) this.fail(entry);
  }
}
