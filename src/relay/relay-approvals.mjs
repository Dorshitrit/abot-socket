import { expectedResponseType } from '../protocol/protocol.mjs';
import { isApprovalCommand } from '../protocol/approval-protocol.mjs';
import { isRecord, isRelayId, relayError } from './relay-runtime-registration.mjs';
import { RelayRequestAdoption } from './relay-request-adoption.mjs';

function validWait(wait) {
  return isRecord(wait) && isRelayId(wait.generation) && isRelayId(wait.waitId)
    && Number.isSafeInteger(wait.revision) && wait.revision >= 0;
}

function validResponse(command, body) {
  if (!body.ok) return typeof body.error === 'string' && body.error.length <= 256;
  if (command.type === 'request.approval.decide.request') {
    return isRecord(body.result) && typeof body.result.accepted === 'boolean'
      && (body.result.duplicate === undefined || typeof body.result.duplicate === 'boolean')
      && (body.result.reason === undefined || typeof body.result.reason === 'string');
  }
  if (!Array.isArray(body.approvals) || body.approvals.length > 64) return false;
  const seen = new Set();
  for (const approval of body.approvals) {
    const request = approval?.request;
    if (!isRecord(approval) || !isRecord(request) || request.requestId !== command.requestId) return false;
    if (typeof request.approvalId !== 'string' || !request.approvalId || request.approvalId.length > 512) return false;
    if (seen.has(request.approvalId)) return false;
    seen.add(request.approvalId);
    if (approval.wait !== undefined && !validWait(approval.wait)) return false;
  }
  if (body.lifecycle !== null && !isRecord(body.lifecycle)) return false;
  if (body.lifecycle?.sessionId !== undefined && body.lifecycle.sessionId !== command.sessionId) return false;
  if (body.lifecycle?.requestId !== undefined && body.lifecycle.requestId !== command.requestId) return false;
  if (body.finalState === null) return true;
  return isRecord(body.finalState) && ['completed', 'failed'].includes(body.finalState.status)
    && body.approvals.length === 0;
}

/** An owner-scoped transport view. The runtime alone stores and decides approvals. */
export class RelayApprovals {
  constructor({ ownership, requests, correlations, transmit, respond, error,
    connected, currentRuntime, assertSessionAvailable }) {
    Object.assign(this, { ownership, requests, correlations, transmit, respond, error });
    this.adoption = new RelayRequestAdoption({ ownership, requests, correlations, transmit, error,
      connected, currentRuntime, assertSessionAvailable,
      recover: (client, runtime, id, command) => this.dispatch(client, runtime, id, command) });
  }

  owned(client, runtime, command) {
    if (!this.ownership) throw relayError('approval_access_unavailable');
    if (!runtime.features.includes('request_approvals_v1')) throw relayError('approvals_unsupported');
    const owner = this.ownership.get(runtime.runtimeId, command.requestId);
    if (!owner || owner.subject !== client.subject || owner.sessionId !== command.sessionId) {
      throw relayError('request_not_owned');
    }
    return owner;
  }

  dispatch(client, runtime, id, command) {
    if (this.adoption.beginIfUnowned(client, runtime, id, command)) return;
    this.adoption.assertNoPendingRequest(runtime, command.requestId);
    const owner = this.owned(client, runtime, command);
    for (const entry of this.correlations.pending.values()) {
      if (entry.runtime === runtime && entry.command.requestId === command.requestId
        && isApprovalCommand(entry.command.type)) throw relayError('approval_request_pending');
    }
    let view;
    const entry = this.correlations.create(client, runtime, id, command, expectedResponseType(command.type), {
      matches: body => validResponse(command, body),
      respond: (_entry, body) => {
        if (!body.ok || body.result?.accepted === false) view.rollback();
        else if (body.finalState) this.requests.markTerminal(view.record);
        this.respond(client, runtime, id, body);
      },
      unknown: () => {
        view.rollback();
        this.error(client, runtime, id, 'outcome_unknown');
      },
      // A sent decision can still take effect after its client closes. Keep the
      // mutation guard until its reply/deadline, but disconnect removes the view.
      retainOnClientDisconnect: true,
    });
    try { view = this.requests.restore(client, runtime, owner); }
    catch (error) { this.correlations.remove(entry); throw error; }
    if (!this.transmit(runtime.peer, { ...command, correlationId: entry.correlationId })) {
      this.correlations.fail(entry);
    }
  }
}
