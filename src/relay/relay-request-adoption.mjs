import { isRecord, relayError } from './relay-runtime-registration.mjs';

const REQUEST_STATUSES = new Set(['streaming', 'awaiting_approval', 'completed', 'failed']);
const requestKey = (runtime, requestId) => JSON.stringify([runtime.generation, requestId]);
const isTerminalRequest = request => ['completed', 'failed'].includes(request.status);

function confirmedSnapshotRequest(command, body) {
  if (!body.ok) throw relayError('request_scope_unverified');
  if (!Array.isArray(body.requests) || body.nextCursor !== null) throw relayError('request_scope_unverified');
  const matches = body.requests.filter(request => isRecord(request) && request.requestId === command.requestId);
  if (matches.length !== 1) throw relayError('request_scope_unverified');
  const request = matches[0];
  if (request.sessionId !== command.sessionId) throw relayError('request_scope_unverified');
  if (!REQUEST_STATUSES.has(request.status)) throw relayError('request_scope_unverified');
  return request;
}

/** First contact with existing computer work needs canonical proof, never a client ownership claim. */
export class RelayRequestAdoption {
  constructor({ ownership, requests, correlations, transmit, connected, currentRuntime,
    assertSessionAvailable, recover, error }) {
    Object.assign(this, { ownership, requests, correlations, transmit, connected, currentRuntime,
      assertSessionAvailable, recover, error });
    this.pending = new Map();
  }

  assertNoPendingRequest(runtime, requestId) {
    if (this.pending.has(requestKey(runtime, requestId))) throw relayError('approval_request_pending');
  }

  assertNoPendingSession(runtime, sessionId) {
    for (const operation of this.pending.values()) {
      if (operation.runtime === runtime && operation.command.sessionId === sessionId) {
        throw relayError('session_busy');
      }
    }
  }

  assertCurrentPrincipal(client, runtime) {
    if (!this.connected(client)) throw relayError('approval_access_unavailable');
    if (!this.currentRuntime(runtime)) throw relayError('runtime_offline');
    if (!client.allowedRuntimeIds.has(runtime.runtimeId)) throw relayError('runtime_forbidden');
    if (this.ownership?.isOwnerSubject?.(client.subject) !== true) throw relayError('request_not_owned');
    if (typeof this.ownership.adopt !== 'function') throw relayError('approval_access_unavailable');
  }

  assertCompatibleBinding(client, runtime, command) {
    const binding = this.requests.bindings.get(JSON.stringify([runtime.runtimeId, command.requestId]));
    if (!binding) return;
    if (!binding.durable || binding.subject !== client.subject || binding.sessionId !== command.sessionId) {
      throw relayError('request_not_owned');
    }
  }

  beginIfUnowned(client, runtime, id, command) {
    if (command.type !== 'request.approvals.request') return false;
    if (!this.ownership || !runtime.features.includes('request_approvals_v1')) return false;
    if (this.ownership.get(runtime.runtimeId, command.requestId)) return false;
    this.assertCurrentPrincipal(client, runtime);
    this.assertNoPendingRequest(runtime, command.requestId);
    this.assertCompatibleBinding(client, runtime, command);
    this.assertSessionAvailable(runtime, command.sessionId);
    const operation = { client, runtime, id, command, key: requestKey(runtime, command.requestId) };
    const snapshot = { type: 'session.snapshot.request', sessionId: command.sessionId, includeRequests: true };
    const entry = this.correlations.create(client, runtime, id, snapshot, 'session.snapshot.response', {
      respond: (_entry, body) => this.afterSnapshot(operation, body),
      unknown: () => this.error(client, runtime, id, 'outcome_unknown'),
      removed: () => {
        if (this.pending.get(operation.key) === operation) this.pending.delete(operation.key);
      },
    });
    this.pending.set(operation.key, operation);
    if (!this.transmit(runtime.peer, { ...snapshot, correlationId: entry.correlationId })) {
      this.correlations.fail(entry);
    }
    return true;
  }

  afterSnapshot(operation, body) {
    const { client, runtime, id, command } = operation;
    try {
      this.assertCurrentPrincipal(client, runtime);
      this.assertSessionAvailable(runtime, command.sessionId);
      this.assertCompatibleBinding(client, runtime, command);
      const canonical = confirmedSnapshotRequest(command, body);
      const terminal = isTerminalRequest(canonical);
      const binding = this.requests.bindings.get(JSON.stringify([runtime.runtimeId, command.requestId]));
      this.requests.assertCapacity(binding, !terminal);
      this.ownership.adopt({ subject: client.subject, deviceId: client.sessionId,
        runtimeId: runtime.runtimeId, sessionId: command.sessionId, requestId: command.requestId }, terminal);
      // Normal recovery binds before receiving approval events and retains the runtime's decision checks.
      this.recover(client, runtime, id, command);
    } catch (error) {
      this.error(client, runtime, id, error.code ?? 'approval_access_unavailable');
    }
  }
}
