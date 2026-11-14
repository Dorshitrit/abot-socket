import { randomUUID } from 'node:crypto';
import { normalizeClientCommand, expectedResponseType } from '../protocol/protocol.mjs';
import { createRelayClient, admitRelayCommand } from './relay-client-admission.mjs';
import { RelayCorrelations } from './relay-correlations.mjs';
import { RelayRequests } from './relay-requests.mjs';
import { RelayApprovals } from './relay-approvals.mjs';
import { isApprovalCommand } from '../protocol/approval-protocol.mjs';
import { assertSparkChatSupported } from '../protocol/spark-chat-protocol.mjs';
import { RelaySessionMutations, isSessionMutation } from './relay-session-mutations.mjs';
import { isBoundedRuntimeFrame, isRelayId, parseRuntimeRegistration,
  validateRuntimeGrant, relayError } from './relay-runtime-registration.mjs';

export class Relay {
  constructor({ now = Date.now, send, close, observeRequest, ownership, isClientAuthorized = () => true }) {
    this.now = now;
    this.send = send;
    this.close = close;
    this.ownership = ownership;
    this.clients = new Map();
    this.runtimes = new Map();
    this.runtimePeers = new Map();
    this.requests = new RelayRequests({ now, ownership, observe: observeRequest,
      event: (client, runtimeId, body) => this.deliver(client, { type: 'relay.event', runtimeId, body }),
      unknown: (client, record) => this.error(client.peer, undefined, record.runtime.runtimeId,
        'outcome_unknown', { requestId: record.requestId }),
    });
    this.correlations = new RelayCorrelations({ now,
      respond: (entry, body) => this.deliver(entry.client, { type: 'relay.response', id: entry.id,
        runtimeId: entry.runtime.runtimeId, body }),
      unknown: entry => this.error(entry.client.peer, entry.id, entry.runtime.runtimeId, 'outcome_unknown'),
    });
    this.approvals = new RelayApprovals({ ownership, requests: this.requests, correlations: this.correlations,
      transmit: (peer, body) => this.transmit(peer, body),
      connected: client => this.clients.get(client.peer) === client && isClientAuthorized(client),
      currentRuntime: runtime => this.runtimes.get(runtime.runtimeId) === runtime && runtime.registered,
      assertSessionAvailable: (runtime, sessionId) => this.sessionMutations.assertNoPending(runtime, sessionId),
      respond: (client, runtime, id, body) => this.deliver(client, { type: 'relay.response', id,
        runtimeId: runtime.runtimeId, body }),
      error: (client, runtime, id, code) => this.error(client.peer, id, runtime.runtimeId, code),
    });
    this.sessionMutations = new RelaySessionMutations({ now, correlations: this.correlations,
      requests: this.requests, ownership, transmit: (peer, body) => this.transmit(peer, body),
      connected: client => this.clients.get(client.peer) === client,
      error: (operation, code) => this.error(operation.client.peer, operation.id, operation.runtime.runtimeId, code),
      respond: (operation, body) => this.deliver(operation.client, { type: 'relay.response',
        id: operation.id, runtimeId: operation.runtime.runtimeId, body }),
    });
  }

  transmit(peer, body) {
    try { return this.send(peer, body) === true; } catch { return false; }
  }

  terminate(peer, reason) {
    this.disconnect(peer);
    try { this.close(peer, 1008, reason); } catch { /* State is already detached. */ }
  }

  deliver(client, body) {
    if (this.clients.get(client.peer) !== client) return false;
    if (this.transmit(client.peer, body)) return true;
    this.terminate(client.peer, 'transport_unavailable');
    return false;
  }

  error(peer, id, runtimeId, code, body) {
    const client = this.clients.get(peer);
    if (!client) return;
    this.deliver(client, { type: 'relay.error', ...(isRelayId(id) ? { id } : {}),
      ...(isRelayId(runtimeId) ? { runtimeId } : {}), code, ...(body ? { body } : {}) });
  }

  attachRuntime(peer, grant) {
    this.prune();
    if (this.runtimePeers.has(peer) || this.clients.has(peer)) return false;
    try {
      const identity = validateRuntimeGrant(grant);
      if (this.runtimes.has(identity.runtimeId) || this.runtimes.size >= 32) return false;
      const runtime = { ...identity, peer, generation: randomUUID(), registered: false,
        registerBy: this.now() + 5_000, features: [], modelCatalog: null };
      this.runtimePeers.set(peer, runtime);
      this.runtimes.set(runtime.runtimeId, runtime);
      return true;
    } catch { return false; }
  }

  attachClient(peer, identity) {
    this.prune();
    if (this.clients.has(peer) || this.runtimePeers.has(peer) || this.clients.size >= 128) return false;
    try {
      this.clients.set(peer, createRelayClient(peer, identity, this.now()));
      return true;
    } catch { return false; }
  }

  runtimeSnapshot(allowedRuntimeIds) {
    if (!Array.isArray(allowedRuntimeIds) || allowedRuntimeIds.length > 32) return [];
    return [...new Set(allowedRuntimeIds.filter(isRelayId))].map(runtimeId => {
      const runtime = this.runtimes.get(runtimeId);
      const online = runtime?.registered === true;
      return { runtimeId, online,
        modelCatalog: online ? structuredClone(runtime.modelCatalog) : null,
        features: online ? [...runtime.features] : [] };
    });
  }

  register(runtime, body) {
    if (runtime.registered) throw relayError('duplicate_registration');
    const registration = parseRuntimeRegistration(body, runtime.runtimeId);
    Object.assign(runtime, registration, { registered: true });
    const reply = { type: 'registered', agentId: runtime.runtimeId, ok: true,
      modelCatalog: { accepted: true, source: runtime.modelCatalog ? 'runtime' : 'legacy' },
      features: runtime.features };
    if (!this.transmit(runtime.peer, reply)) this.terminate(runtime.peer, 'transport_unavailable');
  }

  runtimeMessage(peer, body) {
    this.prune();
    const runtime = this.runtimePeers.get(peer);
    if (!runtime || this.runtimes.get(runtime.runtimeId) !== runtime) return;
    if (!isBoundedRuntimeFrame(body)) return this.terminate(peer, 'invalid_runtime_frame');
    try {
      if (body.type === 'register') return this.register(runtime, body);
      if (!runtime.registered) return this.terminate(peer, 'registration_required');
      if (this.correlations.receive(runtime, body)) return;
      this.requests.receive(runtime, body);
    } catch (error) {
      this.terminate(peer, error.code ?? 'invalid_runtime_frame');
    }
  }

  clientMessage(peer, message) {
    this.prune();
    const client = this.clients.get(peer);
    if (!client) return;
    try {
      admitRelayCommand(client, message, this.now());
      const runtime = this.runtimes.get(message.runtimeId);
      if (!runtime?.registered) throw relayError('runtime_offline');
      const command = normalizeClientCommand(message.body, runtime.allowedModes);
      this.dispatch(client, runtime, message.id, command);
    } catch (error) {
      this.error(peer, message?.id, message?.runtimeId, error.code ?? 'invalid_command');
    }
  }

  acknowledge(client, runtime, id, body) {
    this.deliver(client, { type: 'relay.ack', id, runtimeId: runtime.runtimeId, body });
  }

  dispatch(client, runtime, id, command) {
    assertSparkChatSupported(command, runtime);
    if (isSessionMutation(command.type)) {
      this.approvals.adoption.assertNoPendingSession(runtime, command.sessionId);
      return this.sessionMutations.dispatch(client, runtime, id, command);
    }
    if (['run_request', 'attachment.upload.request'].includes(command.type) || isApprovalCommand(command.type)) {
      this.sessionMutations.assertNoPending(runtime, command.sessionId);
    }
    if (command.type === 'run_request') return this.dispatchRun(client, runtime, id, command);
    if (isApprovalCommand(command.type)) return this.approvals.dispatch(client, runtime, id, command);
    if (command.type === 'subscribe_request') {
      this.requests.subscribe(client, runtime, command.requestId);
      return this.acknowledge(client, runtime, id, { requestId: command.requestId, status: 'subscribed' });
    }
    if (command.type === 'tool_approval_response') return this.dispatchApproval(client, runtime, id, command);
    if (command.type === 'steer_request') return this.dispatchSteering(client, runtime, id, command);
    const expectedType = expectedResponseType(command.type);
    if (!expectedType) throw relayError('unsupported_command');
    const entry = this.correlations.create(client, runtime, id, command, expectedType);
    const frame = { ...command, correlationId: entry.correlationId };
    if (!this.transmit(runtime.peer, frame)) this.correlations.fail(entry);
  }

  dispatchRun(client, runtime, id, command) {
    this.approvals.adoption.assertNoPendingRequest(runtime, command.requestId);
    const record = this.requests.create(client, runtime, command);
    if (!this.transmit(runtime.peer, command)) {
      this.requests.markUnknown(record, false);
      return this.error(client.peer, id, runtime.runtimeId, 'outcome_unknown');
    }
    this.acknowledge(client, runtime, id, { requestId: command.requestId, status: 'dispatched' });
  }

  dispatchApproval(client, runtime, id, command) {
    this.requests.consumeApproval(client, runtime, command);
    if (!this.transmit(runtime.peer, command)) return this.error(client.peer, id, runtime.runtimeId, 'outcome_unknown');
    this.acknowledge(client, runtime, id, { approvalId: command.approvalId, status: 'dispatched' });
  }

  dispatchSteering(client, runtime, id, command) {
    this.requests.owned(client, runtime, command.requestId, true);
    const entry = this.correlations.create(client, runtime, id, command, 'steer_ack');
    try { this.requests.reserveSteering(client, runtime, command); }
    catch (error) { this.correlations.remove(entry); throw error; }
    if (!this.transmit(runtime.peer, command)) this.correlations.fail(entry);
  }

  disconnect(peer) {
    const client = this.clients.get(peer);
    if (client) {
      this.clients.delete(peer);
      this.requests.disconnectClient(client);
      this.correlations.disconnectClient(client);
    }
    const runtime = this.runtimePeers.get(peer);
    if (!runtime) return;
    this.runtimePeers.delete(peer);
    if (this.runtimes.get(runtime.runtimeId) === runtime) this.runtimes.delete(runtime.runtimeId);
    this.correlations.disconnectRuntime(runtime);
    this.requests.disconnectRuntime(runtime);
  }

  prune() {
    for (const runtime of this.runtimePeers.values()) {
      if (!runtime.registered && runtime.registerBy <= this.now()) this.terminate(runtime.peer, 'registration_timeout');
    }
    this.correlations.prune();
    this.requests.prune();
    this.ownership?.prune();
  }
}
