import { isRelayId, relayError } from './relay-runtime-registration.mjs';

const MAX_ACTIVE = 128;
const MAX_BINDINGS = 512;
const BINDING_TTL_MS = 12 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const STREAM_TYPES = new Set(['token', 'event', 'completed', 'failed', 'session_message']);
const keyFor = (runtimeId, requestId) => JSON.stringify([runtimeId, requestId]);

function canConsumeObservedApproval(approval, approved, now) {
  if (approval.state === 'expired') return approved === false;
  if (approval.state !== 'pending') return false;
  if (approval.expiresAt <= now) return approved === false;
  return true;
}

export class RelayRequests {
  constructor({ now, event, unknown, observe = () => {} }) {
    this.now = now;
    this.event = event;
    this.unknown = unknown;
    this.observe = observe;
    this.bindings = new Map();
  }

  create(client, runtime, command) {
    const key = keyFor(runtime.runtimeId, command.requestId);
    if (this.bindings.has(key)) throw relayError('request_id_conflict');
    if (this.bindings.size >= MAX_BINDINGS) throw relayError('request_capacity');
    const activeCount = [...this.bindings.values()].filter(record => record.state === 'active').length;
    if (activeCount >= MAX_ACTIVE) throw relayError('active_request_capacity');
    const record = { key, subject: client.subject, deviceId: client.sessionId, runtime, requestId: command.requestId,
      sessionId: command.sessionId, state: 'active', subscribers: new Set([client]),
      expiresAt: this.now() + BINDING_TTL_MS, approvals: new Map(), steering: new Set() };
    this.bindings.set(key, record);
    return record;
  }

  owned(client, runtime, requestId, requireActive = false) {
    const record = this.bindings.get(keyFor(runtime.runtimeId, requestId));
    if (!record || record.subject !== client.subject) throw relayError('request_not_owned');
    if (requireActive && (record.state !== 'active' || record.runtime !== runtime)) {
      throw relayError('request_not_active');
    }
    return record;
  }

  subscribe(client, runtime, requestId) {
    const record = this.owned(client, runtime, requestId);
    record.subscribers.add(client);
    return record;
  }

  reserveSteering(client, runtime, body) {
    const record = this.owned(client, runtime, body.requestId, true);
    if (!runtime.features.includes('request_steering_v1')) throw relayError('steering_unsupported');
    if (record.steering.has(body.steerId)) throw relayError('duplicate_steer_id');
    if (record.steering.size >= 128) throw relayError('steering_capacity');
    record.steering.add(body.steerId);
  }

  consumeApproval(client, runtime, body) {
    for (const record of this.bindings.values()) {
      if (record.runtime !== runtime || record.subject !== client.subject || record.state !== 'active') continue;
      const approval = record.approvals.get(body.approvalId);
      if (!approval) continue;
      if (!canConsumeObservedApproval(approval, body.approved, this.now())) throw relayError('approval_not_pending');
      // Consume before send: failure cannot make a possibly executed decision reusable.
      approval.state = 'used';
      return record;
    }
    throw relayError('approval_not_pending');
  }

  receive(runtime, body) {
    if (!STREAM_TYPES.has(body.type) || !isRelayId(body.requestId)) return false;
    const record = this.bindings.get(keyFor(runtime.runtimeId, body.requestId));
    if (!record || record.runtime !== runtime || record.state !== 'active') return false;
    if (!this.acceptSessionIdentity(record, body)) return false;
    if (body.type === 'event' && (typeof body.name !== 'string' || body.name.length > 256)) return false;
    if (body.type === 'event' && body.name === 'tool.approval.required') {
      if (!this.observeApproval(record, body.approvalId)) return false;
    }
    if (body.type === 'event' && ['tool.approval.granted', 'tool.approval.rejected'].includes(body.name)) {
      const approval = record.approvals.get(body.approvalId);
      if (approval) approval.state = 'closed';
    }
    if (body.type === 'completed' || body.type === 'failed') {
      record.state = 'terminal';
      record.expiresAt = this.now() + BINDING_TTL_MS;
      this.invalidateApprovals(record);
    }
    try {
      this.observe({ deviceId: record.deviceId, runtimeId: runtime.runtimeId,
        sessionId: record.sessionId, requestId: record.requestId }, body);
    } catch { /* Notification storage must not interrupt the chat stream. */ }
    for (const client of record.subscribers) this.event(client, runtime.runtimeId, body);
    return true;
  }

  acceptSessionIdentity(record, body) {
    if (body.sessionId === undefined || body.sessionId === null) return true;
    if (!isRelayId(body.sessionId)) return false;
    if (record.sessionId && record.sessionId !== body.sessionId) return false;
    record.sessionId = body.sessionId;
    return true;
  }

  observeApproval(record, approvalId) {
    if (typeof approvalId !== 'string' || !approvalId || approvalId.length > 512) return false;
    const existing = record.approvals.get(approvalId);
    if (existing) return existing.state === 'pending' && existing.expiresAt > this.now();
    if (record.approvals.size >= 64) return false;
    // Approval IDs may not be reused between simultaneous requests on one runtime.
    for (const other of this.bindings.values()) {
      if (other.runtime === record.runtime && other.approvals.has(approvalId)) return false;
    }
    record.approvals.set(approvalId, { state: 'pending', expiresAt: this.now() + APPROVAL_TTL_MS });
    return true;
  }

  invalidateApprovals(record) {
    for (const approval of record.approvals.values()) approval.state = 'closed';
  }

  markUnknown(record, notify = true) {
    if (record.state !== 'active') return;
    record.state = 'unknown';
    record.expiresAt = this.now() + BINDING_TTL_MS;
    this.invalidateApprovals(record);
    if (notify) for (const client of record.subscribers) this.unknown(client, record);
  }

  disconnectRuntime(runtime) {
    for (const record of this.bindings.values()) if (record.runtime === runtime) this.markUnknown(record);
  }

  disconnectClient(client) {
    for (const record of this.bindings.values()) record.subscribers.delete(client);
  }

  prune() {
    for (const record of this.bindings.values()) {
      for (const approval of record.approvals.values()) {
        if (approval.expiresAt <= this.now() && approval.state === 'pending') approval.state = 'expired';
      }
      if (record.expiresAt > this.now()) continue;
      if (record.state === 'active') {
        this.markUnknown(record);
        continue;
      }
      this.bindings.delete(record.key);
    }
  }
}
