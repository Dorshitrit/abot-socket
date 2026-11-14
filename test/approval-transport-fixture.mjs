import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { AuthService } from '../src/auth/auth.mjs';
import { createSocketServer } from '../src/transport/server.mjs';
import { digestToken } from '../src/auth/runtime-credentials.mjs';

const HEADERS = { host: 'socket.example.test', 'x-forwarded-proto': 'https', 'x-socket-client-ip': '192.0.2.1' };
const TOKENS = new Map(['alpha', 'beta'].map(id => [id, `local-test-runtime-${id}`.padEnd(64, 'x')]));

/** Actual HTTP/WS transport and persistent authentication; runtimes are scripted peers. */
export async function approvalTransportFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-approval-transport-')));
  const stateDirectory = join(root, 'state');
  const operator = new AuthService({ stateDirectory });
  const sockets = new Set();
  let app;
  let address;
  let commandSequence = 0;
  async function start() {
    app = createSocketServer({ stateDirectory, publicOrigin: 'https://socket.example.test',
      runtimeGrants: [...TOKENS].map(([runtimeId, token]) => ({
        runtimeId, tokenSha256: digestToken(token), allowedModes: ['ask'],
      })) });
    address = await app.listen(0);
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    operator.close();
    rmSync(root, { recursive: true, force: true });
  });
  await start();

  const request = (path, { method = 'GET', token, body } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method,
      headers: { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('Local approval HTTP timed out')));
    req.on('error', reject); req.end(encoded);
  });

  async function connect(path, token) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });
    sockets.add(socket);
    const pending = [];
    const frames = [];
    const received = [];
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('error', () => {});
    socket.on('message', data => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      const index = pending.findIndex(waiter => waiter.predicate(frame));
      if (index < 0) { frames.push(frame); return; }
      const [waiter] = pending.splice(index, 1);
      clearTimeout(waiter.timer); waiter.resolve(frame);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const waiter of pending.splice(0)) {
        clearTimeout(waiter.timer); waiter.reject(new Error('Local approval peer closed'));
      }
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, closed, received, send: frame => socket.send(JSON.stringify(frame)), next(predicate = () => true) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: setTimeout(() => {
          const index = pending.indexOf(waiter);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error('Local approval frame timed out'));
        }, 3000) };
        pending.push(waiter);
      });
    } };
  }

  async function client(token) {
    const peer = await connect('/v2/realtime', token);
    peer.authenticated = await peer.next(frame => frame.type === 'authenticated');
    return peer;
  }

  async function runtime(runtimeId = 'alpha', features = ['request_approvals_v1']) {
    const peer = await connect('/agent-bridge', TOKENS.get(runtimeId));
    peer.send({ type: 'register', agentId: runtimeId, features });
    await peer.next(frame => frame.type === 'registered');
    return peer;
  }

  return { stateDirectory, operator, request, client, runtime,
    async pair(deviceName = 'Test phone') {
      const response = await request('/v2/pairing/redeem', { method: 'POST',
        body: { ...operator.createPairing(), deviceName } });
      if (response.status !== 200) throw new Error('Fixture device pairing failed');
      return response.body;
    },
    command(peer, body, runtimeId = 'alpha') {
      const id = `approval-command-${++commandSequence}`;
      peer.send({ id, runtimeId, body });
      return id;
    },
    async restart() {
      await app.close();
      await start();
    },
  };
}

export function savedApprovalResponse(query) {
  const { requestId, sessionId, correlationId } = query;
  const wait = { generation: 'fixture-generation', waitId: 'fixture-wait', revision: 7 };
  return { type: 'request.approvals.response', correlationId, sessionId, requestId, ok: true,
    approvals: [{ request: { requestId, approvalId: 'fixture-approval',
      call: { tool: 'fixture_tool', params: {} } }, wait }],
    lifecycle: { schemaVersion: 1, sessionId, requestId, generation: wait.generation,
      status: 'awaiting_approval', revision: wait.revision,
      wait: { waitId: wait.waitId, approvals: [] }, decisionReceipts: [] },
    finalState: null };
}
