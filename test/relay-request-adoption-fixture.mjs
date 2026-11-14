import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';
import { ownershipFixture } from './request-ownership-fixture.mjs';

export const recovery = { type: 'request.approvals.request', sessionId: 'computer-chat', requestId: 'computer-request' };

export function adoptionFixture(t) {
  const storage = ownershipFixture(t);
  const sent = [], revoked = new Set();
  let sequence = 0;
  const relay = new Relay({ now: storage.now, ownership: storage.store,
    send: (peer, body) => { sent.push({ peer, body: structuredClone(body) }); return true; },
    close() {}, isClientAuthorized: client => !revoked.has(client.peer) });
  const f = { ...storage, relay, revoked, sent,
    runtime(runtimeId = 'runtime', features = ['request_approvals_v1']) {
      const peer = { runtimeId, instance: ++sequence };
      assert.equal(relay.attachRuntime(peer, { runtimeId }), true);
      relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, features });
      return peer;
    },
    client(subject = storage.database.ownerId, allowedRuntimeIds = ['runtime']) {
      const peer = { deviceId: `device-${++sequence}` };
      assert.equal(relay.attachClient(peer, { subject, sessionId: peer.deviceId, allowedRuntimeIds }), true);
      return peer;
    },
    command(peer, body = recovery, runtimeId = 'runtime') {
      const id = `command-${++sequence}`;
      relay.clientMessage(peer, { id, runtimeId, body });
      return id;
    },
    messages: peer => sent.filter(entry => entry.peer === peer).map(entry => entry.body),
    last: peer => f.messages(peer).at(-1),
    snapshot(peer, overrides = {}) {
      const query = f.last(peer);
      const body = { type: 'session.snapshot.response', correlationId: query.correlationId,
        sessionId: recovery.sessionId, ok: true, nextCursor: null, messages: [],
        requests: [{ sessionId: recovery.sessionId, requestId: recovery.requestId, status: 'awaiting_approval' }],
        ...overrides };
      relay.runtimeMessage(peer, body);
      return body;
    },
    recovered(peer, overrides = {}) {
      const query = f.last(peer);
      relay.runtimeMessage(peer, { type: 'request.approvals.response', correlationId: query.correlationId,
        sessionId: recovery.sessionId, requestId: recovery.requestId, ok: true,
        approvals: [{ request: { requestId: recovery.requestId, approvalId: 'approval-1' },
          wait: { generation: 'generation-1', waitId: 'wait-1', revision: 7 } }],
        lifecycle: { sessionId: recovery.sessionId, requestId: recovery.requestId, status: 'awaiting_approval' },
        finalState: null, ...overrides });
    },
    owner: () => storage.store.get('runtime', recovery.requestId),
  };
  return f;
}
