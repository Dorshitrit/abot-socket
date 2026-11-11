import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { AuthService } from '../src/auth/auth.mjs';
import { createSocketServer } from '../src/transport/server.mjs';
import { digestToken } from '../src/auth/runtime-credentials.mjs';

const HEADERS = { host: 'socket.example.test', 'x-forwarded-proto': 'https', 'x-socket-client-ip': '192.0.2.1' };
const RUNTIME_TOKEN = 'dummy-runtime-token-for-local-tests'.padEnd(64, 'x');

export async function notificationTransportFixture(t, notificationDelivery) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-notification-transport-')));
  const stateDirectory = join(root, 'state');
  const operator = new AuthService({ stateDirectory });
  const app = createSocketServer({ stateDirectory, publicOrigin: 'https://socket.example.test', notificationDelivery,
    runtimeGrants: [{ runtimeId: 'test-runtime', tokenSha256: digestToken(RUNTIME_TOKEN) }] });
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close(); operator.close(); rmSync(root, { recursive: true, force: true });
  });
  const address = await app.listen(0);
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
    req.setTimeout(3000, () => req.destroy(new Error('Local test HTTP timed out')));
    req.on('error', reject); req.end(encoded);
  });
  const connect = async (path, token) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });
    sockets.add(socket);
    const pending = []; const frames = [];
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('error', () => {});
    socket.on('message', data => {
      const body = JSON.parse(data.toString());
      const index = pending.findIndex(waiter => waiter.predicate(body));
      if (index < 0) { frames.push(body); return; }
      const [waiter] = pending.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(body);
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, closed, send: body => socket.send(JSON.stringify(body)), next(predicate = () => true) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1); reject(new Error('Local test frame timed out'));
        }, 3000) };
        pending.push(waiter);
      });
    } };
  };
  return { app, operator, request,
    pair: async () => (await request('/v2/pairing/redeem', { method: 'POST',
      body: { ...operator.createPairing(), deviceName: 'Test phone' } })).body,
    client: token => connect('/v2/realtime', token),
    runtime: () => connect('/agent-bridge', RUNTIME_TOKEN) };
}
