import { expectedResponseType } from '../protocol/protocol.mjs';
import { relayError } from './relay-runtime-registration.mjs';

const MUTATIONS = new Set([
  'session.delete.request', 'session.messages.clear.request', 'session.message.delete.request',
]);
const MUTATION_TIMEOUT_MS = 30_000;

export function isSessionMutation(type) {
  return MUTATIONS.has(type);
}

const sessionKey = (runtime, sessionId) => JSON.stringify([runtime.generation, sessionId]);

/** A bounded read-before-delete guard, not an atomic lock over independent clients. */
export class RelaySessionMutations {
  constructor({ now, correlations, requests, transmit, connected, error, respond }) {
    Object.assign(this, { now, correlations, requests, transmit, connected, error, respond });
    this.pending = new Map();
  }

  assertNoPending(runtime, sessionId) {
    if (this.pending.has(sessionKey(runtime, sessionId))) throw relayError('session_mutation_pending');
  }

  assertNoObservedWork(runtime, sessionId) {
    for (const record of this.requests.bindings.values()) {
      if (record.runtime !== runtime || record.sessionId !== sessionId) continue;
      if (record.state !== 'terminal') throw relayError('session_busy');
    }
    for (const entry of this.correlations.pending.values()) {
      if (entry.runtime === runtime && entry.command.sessionId === sessionId
        && entry.command.type === 'attachment.upload.request') throw relayError('session_busy');
    }
  }

  dispatch(client, runtime, id, command) {
    this.assertNoPending(runtime, command.sessionId);
    this.assertNoObservedWork(runtime, command.sessionId);
    const operation = { client, runtime, id, command,
      expiresAt: this.now() + MUTATION_TIMEOUT_MS, key: sessionKey(runtime, command.sessionId) };
    this.snapshot(operation);
  }

  snapshot(operation) {
    const command = { type: 'session.snapshot.request', sessionId: operation.command.sessionId,
      includeRequests: true };
    this.send(operation, command, body => this.afterSnapshot(operation, body));
  }

  afterSnapshot(operation, body) {
    if (!this.connected(operation.client)) return;
    try {
      if (this.now() >= operation.expiresAt) throw relayError('session_state_unavailable');
      this.assertNoObservedWork(operation.runtime, operation.command.sessionId);
      if (!body.ok) throw relayError(body.error === 'session_not_found' ? 'session_not_found' : 'session_state_unavailable');
      // The existing bridge returns every request and no continuation cursor.
      // A partial/newer contract cannot prove idleness; never guess pagination.
      if (!Array.isArray(body.requests) || body.nextCursor !== null) throw relayError('session_state_unavailable');
      for (const request of body.requests) {
        if (!request || typeof request !== 'object') throw relayError('session_state_unavailable');
        if (request.sessionId !== operation.command.sessionId) throw relayError('session_state_unavailable');
        if (!['completed', 'failed'].includes(request.status)) throw relayError('session_busy');
      }
      this.send(operation, operation.command, result => this.respond(operation, result));
    } catch (error) {
      this.error(operation, error.code ?? 'session_state_unavailable');
    }
  }

  send(operation, command, respond) {
    const entry = this.correlations.create(operation.client, operation.runtime, operation.id,
      command, expectedResponseType(command.type), {
        respond: (_entry, body) => respond(body),
        unknown: () => this.error(operation, 'outcome_unknown'),
        removed: () => {
          if (this.pending.get(operation.key) === operation) this.pending.delete(operation.key);
        },
        // Keep the lock while an already sent mutation may still be running.
        retainOnClientDisconnect: true,
      });
    entry.expiresAt = operation.expiresAt;
    this.pending.set(operation.key, operation);
    if (!this.transmit(operation.runtime.peer, { ...command, correlationId: entry.correlationId })) {
      this.correlations.fail(entry);
    }
  }
}
