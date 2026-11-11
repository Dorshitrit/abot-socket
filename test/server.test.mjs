import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/auth/auth.mjs';
import { createSocketServer } from '../src/transport/server.mjs';
import { digestToken } from '../src/auth/runtime-credentials.mjs';

const runtimeToken = 'test_runtime_credential_'.padEnd(64, 'x');
const proxyHeaders = { host: 'socket.example.test', 'x-forwarded-proto': 'https', 'x-socket-client-ip': '192.0.2.1' };

function connect(address, path, headers = proxyHeaders) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers });
  const frames = [];
  const waiters = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) frames.push(frame);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(frame); }
  });
  socket.on('error', () => {});
  return {
    socket,
    opened: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    closed: new Promise((resolve) => socket.once('close', resolve)),
    send: (value) => socket.send(JSON.stringify(value)),
    next(predicate = () => true) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1);
          reject(new Error('Timed out waiting for protocol frame'));
        }, 2500) };
        waiters.push(waiter);
      });
    },
  };
}

async function fixture(t) {
  const stateDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'abot-pairing-transport-')));
  const operator = new AuthService({ stateDirectory });
  const app = createSocketServer({ stateDirectory,
    publicOrigin: 'https://socket.example.test',
    runtimeGrants: [{ runtimeId: 'test-runtime', tokenSha256: digestToken(runtimeToken), allowedModes: ['ask'] }] });
  const address = await app.listen(0);
  t.after(async () => { await app.close(); operator.close(); rmSync(stateDirectory, { recursive: true, force: true }); });
  const request = async (path, body, { token, method = 'POST', headers = {} } = {}) => {
    // Emulate the reverse proxy on the wire. Fetch derives Host from its URL
    // and can ignore an explicitly supplied Host header (including on Node 26).
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method,
        headers: { ...proxyHeaders, ...headers,
          ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()), headers: new Headers(response.headers) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(2500, () => req.destroy(new Error('Test HTTP request timed out')));
      req.on('error', reject);
      req.end(encoded);
    });
  };
  const login = async () => request('/v2/pairing/redeem', {
    ...operator.createPairing(), deviceName: 'Test iPhone',
  });
  return { app, address, operator, request, login };
}

test('local transport pairs a device and runtime, routes chat and revokes a connected device', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.ok(login.body.token);
  const runtime = connect(f.address, '/agent-bridge', { ...proxyHeaders, authorization: `Bearer ${runtimeToken}` });
  await runtime.opened;
  runtime.send({ type: 'register', agentId: 'test-runtime', features: ['request_steering_v1'] });
  assert.equal((await runtime.next()).type, 'registered');
  const catalog = await f.request('/v2/runtimes', undefined, { token: login.body.token, method: 'GET' });
  assert.equal(catalog.body.runtimes[0].runtimeId, 'test-runtime');
  assert.equal(catalog.body.runtimes[0].online, true);
  const client = connect(f.address, '/v2/realtime', { ...proxyHeaders, authorization: `Bearer ${login.body.token}` });
  await client.opened;
  assert.equal((await client.next()).type, 'authenticated');
  client.send({ id: 'command-1', runtimeId: 'test-runtime', body: {
    type: 'run_request', requestId: 'request-1', sessionId: 'session-1', text: 'Test only',
  } });
  const run = await runtime.next((frame) => frame.type === 'run_request');
  assert.equal(run.toolPermissionMode, 'ask');
  assert.equal((await client.next((frame) => frame.type === 'relay.ack')).id, 'command-1');
  runtime.send({ type: 'completed', requestId: 'request-1', output: 'Test response' });
  const completed = await client.next((frame) => frame.type === 'relay.event');
  assert.equal(completed.body.output, 'Test response');
  const revoked = await f.request(`/v2/auth/sessions/${login.body.session.id}`, undefined,
    { token: login.body.token, method: 'DELETE' });
  assert.equal(revoked.body.revoked, true);
  await client.closed;
  assert.equal((await f.request('/v2/auth/sessions', undefined, { token: login.body.token, method: 'GET' })).status, 401);
});

test('authority, unknown pairing, missing identity and wrong-role credentials fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/health', undefined, { method: 'GET', headers: { host: 'attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/health', undefined, { method: 'GET', headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/health', undefined, { method: 'GET', headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  assert.equal((await f.request('/health', undefined, { method: 'GET', headers: { 'x-socket-client-ip': '192.0.2.1, 192.0.2.2' } })).status, 403);
  assert.equal((await f.request('/v2/auth/sessions', undefined, { method: 'GET' })).status, 401);
  assert.equal((await f.request('/v2/auth/request', { email: 'stranger@example.test' })).status, 401);
  assert.equal((await f.request('/v2/auth/verify', { code: '12345678' })).status, 401);
  assert.equal((await f.request('/v2/pairing/redeem', {
    pairingId: 'x'.repeat(32), code: '123456', deviceName: 'Phone',
  })).status, 401);
  const wrongRuntime = connect(f.address, '/agent-bridge', proxyHeaders);
  await assert.rejects(wrongRuntime.opened);
  const client = connect(f.address, '/v2/realtime', { ...proxyHeaders, authorization: `Bearer ${runtimeToken}` });
  await assert.rejects(client.opened);
  const query = connect(f.address, '/v2/realtime?token=not-accepted');
  await assert.rejects(query.opened);
});

test('canonical session RPC is correlated and runtime/admin is not forwarded', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const runtime = connect(f.address, '/agent-bridge', { ...proxyHeaders, authorization: `Bearer ${runtimeToken}` });
  await runtime.opened;
  runtime.send({ type: 'register', agentId: 'test-runtime' });
  await runtime.next();
  const client = connect(f.address, '/v2/realtime', { ...proxyHeaders, authorization: `Bearer ${login.body.token}` });
  await client.opened;
  await client.next();
  client.send({ id: 'list-1', runtimeId: 'test-runtime', body: { type: 'session.list.request', limit: 10 } });
  const query = await runtime.next((frame) => frame.type === 'session.list.request');
  assert.notEqual(query.correlationId, 'list-1');
  runtime.send({ type: 'session.list.response', correlationId: query.correlationId, ok: true, sessions: [] });
  const response = await client.next((frame) => frame.type === 'relay.response');
  assert.equal(response.id, 'list-1');
  assert.deepEqual(response.body.sessions, []);
  client.send({ id: 'admin-1', runtimeId: 'test-runtime', body: { type: 'runtime.config.patch', value: {} } });
  assert.equal((await client.next((frame) => frame.id === 'admin-1')).type, 'relay.error');
});

test('operator revocation closes an already connected client and HTTP pairing is single use', async (t) => {
  const f = await fixture(t);
  const pairing = { ...f.operator.createPairing(), deviceName: 'Phone' };
  const responses = await Promise.all([
    f.request('/v2/pairing/redeem', pairing), f.request('/v2/pairing/redeem', pairing),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
  const login = responses.find((r) => r.status === 200);
  const client = connect(f.address, '/v2/realtime', { ...proxyHeaders, authorization: `Bearer ${login.body.token}` });
  await client.opened; await client.next();
  assert.equal(f.operator.revokeDevice(login.body.session.id), true);
  await Promise.race([client.closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Revoked connection remained open')), 2500);
    timer.unref();
  })]);
});

test('paired client mutations cross the real relay transport only after idle runtime snapshots', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const runtime = connect(f.address, '/agent-bridge', { ...proxyHeaders, authorization: `Bearer ${runtimeToken}` });
  await runtime.opened;
  runtime.send({ type: 'register', agentId: 'test-runtime' });
  await runtime.next();
  const catalog = await f.request('/v2/runtimes', undefined, { token: login.body.token, method: 'GET' });
  const capabilities = catalog.body.runtimes[0].capabilities;
  assert.equal(capabilities.sessionMutation, true);
  const client = connect(f.address, '/v2/realtime', { ...proxyHeaders, authorization: `Bearer ${login.body.token}` });
  await client.opened;
  const authenticated = await client.next();
  assert.deepEqual(authenticated.capabilities, capabilities);
  for (const name of ['session.delete', 'session.messages.clear', 'session.message.delete']) {
    const body = { type: `${name}.request`, sessionId: 'fixture-session',
      ...(name === 'session.message.delete' ? { messageId: 7 } : {}) };
    client.send({ id: name, runtimeId: 'test-runtime', body });
    const snapshot = await runtime.next();
    assert.equal(snapshot.type, 'session.snapshot.request');
    assert.equal(snapshot.includeRequests, true);
    runtime.send({ type: 'session.snapshot.response', correlationId: snapshot.correlationId,
      ok: true, sessionId: body.sessionId, messages: [], requests: [], nextCursor: null });
    const mutation = await runtime.next();
    assert.equal(mutation.type, body.type);
    assert.notEqual(mutation.correlationId, snapshot.correlationId);
    const response = { type: `${name}.response`, correlationId: mutation.correlationId,
      ok: true, sessionId: body.sessionId,
      ...(name === 'session.messages.clear' ? { cleared: true } : { deleted: true }),
      ...(name === 'session.message.delete' ? { messageId: '7', deletedRequestId: 'fixture-request' } : {}) };
    runtime.send(response);
    const received = await client.next(frame => frame.type === 'relay.response');
    assert.equal(received.id, name);
    assert.deepEqual(received.body, response);
  }
});
