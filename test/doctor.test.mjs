import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPublicEndpoint } from '../src/cli/doctor.mjs';

const ORIGIN = 'https://socket.example.test:9443';
const HEALTH = Buffer.from('{"ok":true,"version":2}');

function transport(behavior, { statusCode = 200, headers = {} } = {}) {
  const calls = [];
  const request = new EventEmitter();
  const response = new EventEmitter();
  request.destroy = () => { request.destroyed = true; };
  response.destroy = () => { response.destroyed = true; };
  response.statusCode = statusCode;
  response.headers = { 'content-type': 'application/json', ...headers };
  response.complete = true;
  const requestImpl = (url, options, callback) => {
    calls.push({ url, options });
    request.end = () => queueMicrotask(() => behavior({ request, response, callback }));
    return request;
  };
  return { requestImpl, calls, request, response };
}

function respond({ response, callback }, body = HEALTH) {
  callback(response);
  response.emit('data', body);
  response.emit('end');
}

test('doctor probes only canonical HTTPS /health without credentials or spoofed proxy headers', async () => {
  const fixture = transport(respond);
  const result = await checkPublicEndpoint(ORIGIN, fixture);
  assert.deepEqual(result, { ok: true, code: 'reachable', runtimeVerified: false });
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  assert.equal(call.url.href, `${ORIGIN}/health`);
  assert.deepEqual(call.options, {
    method: 'GET', headers: { Accept: 'application/json' },
    rejectUnauthorized: true, agent: false, maxHeaderSize: 8192,
  });
  assert.equal(fixture.request.destroyed, true);
  assert.equal(fixture.response.destroyed, true);
  assert.equal(fixture.response.listenerCount('data'), 0);
  assert.equal(fixture.response.listenerCount('end'), 0);
});

test('invalid origins and deadlines are rejected before the transport runs', async () => {
  let calls = 0;
  const requestImpl = () => { calls++; throw new Error('Must not connect'); };
  for (const origin of [null, '', 'http://socket.example.test', `${ORIGIN}/`,
    `${ORIGIN}/path`, `${ORIGIN}?key=private`, `${ORIGIN}#fragment`,
    'https://name:password@socket.example.test', ' https://socket.example.test',
    'https://socket.example.test\n', 'x'.repeat(2049)]) {
    await assert.rejects(checkPublicEndpoint(origin, { requestImpl }), /canonical HTTPS origin/);
  }
  for (const timeoutMs of [0, -1, 5001, Infinity, NaN, 0.5]) {
    await assert.rejects(checkPublicEndpoint(ORIGIN, { requestImpl, timeoutMs }), /deadline/);
  }
  assert.equal(calls, 0);
});

test('redirects are rejected without a second request or response-body disclosure', async () => {
  const fixture = transport(respond, { statusCode: 302, headers: { location: 'https://elsewhere.invalid/SECRET' } });
  assert.deepEqual(await checkPublicEndpoint(ORIGIN, fixture), {
    ok: false, code: 'redirect_rejected', runtimeVerified: false,
  });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.request.destroyed, true);
  assert.equal(fixture.response.destroyed, true);
});

test('non-200, non-JSON, malformed and incompatible responses fail closed', async () => {
  for (const [options, body] of [
    [{ statusCode: 503 }, HEALTH],
    [{ headers: { 'content-type': 'text/html' } }, HEALTH],
    [{}, Buffer.from('SECRET private diagnostic')],
    [{}, Buffer.from('{"ok":false,"version":2}')],
    [{}, Buffer.from('{"ok":true,"version":3}')],
    [{}, Buffer.from('[]')],
  ]) {
    const fixture = transport((args) => respond(args, body), options);
    assert.deepEqual(await checkPublicEndpoint(ORIGIN, fixture), {
      ok: false, code: 'unexpected_response', runtimeVerified: false,
    });
  }
});

test('declared and streamed response bodies are bounded at 4096 bytes', async () => {
  for (const length of ['4097', 'invalid']) {
    const fixture = transport(respond, { headers: { 'content-length': length } });
    assert.equal((await checkPublicEndpoint(ORIGIN, fixture)).code, 'unexpected_response');
    assert.equal(fixture.response.destroyed, true);
  }
  const exact = Buffer.concat([HEALTH, Buffer.alloc(4096 - HEALTH.length, ' ')]);
  assert.equal((await checkPublicEndpoint(ORIGIN, transport((args) => respond(args, exact)))).ok, true);
  const overflow = transport(({ response, callback }) => {
    callback(response);
    response.emit('data', Buffer.alloc(4000));
    response.emit('data', Buffer.alloc(97));
  });
  assert.equal((await checkPublicEndpoint(ORIGIN, overflow)).code, 'unexpected_response');
  assert.equal(overflow.request.destroyed, true);
});

test('whole-operation deadline covers connection wait and an incomplete response', async () => {
  for (const behavior of [() => {}, ({ callback, response }) => callback(response)]) {
    const fixture = transport(behavior);
    assert.deepEqual(await checkPublicEndpoint(ORIGIN, { ...fixture, timeoutMs: 5 }), {
      ok: false, code: 'timeout', runtimeVerified: false,
    });
    assert.equal(fixture.request.destroyed, true);
  }
});

test('TLS, request, and response failures return only a sanitized code', async () => {
  const privateFailure = new Error('SECRET certificate or server diagnostic');
  for (const fixture of [
    { requestImpl() { throw privateFailure; } },
    transport(({ request }) => request.emit('error', privateFailure)),
    transport(({ response, callback }) => { callback(response); response.emit('error', privateFailure); }),
    transport(({ response, callback }) => { callback(response); response.emit('aborted'); }),
  ]) {
    assert.deepEqual(await checkPublicEndpoint(ORIGIN, fixture), {
      ok: false, code: 'https_unavailable', runtimeVerified: false,
    });
  }
});

test('an ended but incomplete HTTP response is not reported as reachable', async () => {
  const fixture = transport(({ response, callback }) => {
    response.complete = false;
    respond({ response, callback });
  });
  assert.equal((await checkPublicEndpoint(ORIGIN, fixture)).code, 'unexpected_response');
});

test('an unexpected protocol upgrade is rejected and its detached socket is closed', async () => {
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  const fixture = transport(({ request, response }) => request.emit('upgrade', response, socket));
  assert.equal((await checkPublicEndpoint(ORIGIN, fixture)).code, 'unexpected_response');
  assert.equal(socket.destroyed, true);
  assert.equal(fixture.request.destroyed, true);
});
