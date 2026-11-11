import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthService } from '../src/auth/auth.mjs';
import { createSocketServer } from '../src/transport/server.mjs';
import { createReviewPortalServer } from '../src/review/review-portal-server.mjs';
import { digestToken } from '../src/auth/runtime-credentials.mjs';

export const REVIEW_ORIGIN = 'https://review.example.test';
export const SOCKET_ORIGIN = 'https://socket.example.test';
export const REVIEW_USERNAME = 'reviewer';
export const REVIEW_PASSWORD = 'dummy-reviewer-password'.padEnd(43, 'r');
export const RUNTIME_TOKEN = 'dummy-runtime-token-never-in-review-page'.padEnd(64, 'x');
export const BASIC = `Basic ${Buffer.from(`${REVIEW_USERNAME}:${REVIEW_PASSWORD}`).toString('base64')}`;
export const WRONG_BASIC = `Basic ${Buffer.from(`${REVIEW_USERNAME}:${'x'.repeat(43)}`).toString('base64')}`;
export const PASSWORD_SHA256 = createHash('sha256').update(REVIEW_PASSWORD).digest('hex');
const MINUTE = 60_000;

function request(port, origin, path, { method = 'GET', headers = {}, body, form, auth = BASIC,
  ip = '192.0.2.1', chunked = false } = {}) {
  const encoded = form === undefined ? body : new URLSearchParams(form).toString();
  const wireHeaders = {
    host: new URL(origin).host,
    'x-forwarded-proto': 'https',
    'x-socket-client-ip': ip,
    ...(auth ? { authorization: auth } : {}),
    ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    ...(encoded === undefined || chunked ? {} : { 'content-length': Buffer.byteLength(encoded) }),
    ...headers,
  };
  for (const [name, value] of Object.entries(wireHeaders)) if (value === undefined) delete wireHeaders[name];
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: wireHeaders }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.destroy(new Error('Local test response exceeded bound')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Local review HTTP timed out')));
    req.on('error', reject);
    if (chunked && encoded !== undefined) { req.write(encoded.slice(0, 2048)); req.end(encoded.slice(2048)); }
    else req.end(encoded);
  });
}

export async function reviewPortalFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-review-http-')));
  const stateDirectory = join(root, 'state');
  let time = Date.UTC(2026, 0, 1);
  const now = () => time;
  const operator = new AuthService({ stateDirectory, now });
  let portal;
  let socket;
  t.after(async () => {
    await portal?.close(); await socket?.close(); operator.close();
    rmSync(root, { recursive: true, force: true });
  });
  portal = createReviewPortalServer({ publicOrigin: REVIEW_ORIGIN, socketOrigin: SOCKET_ORIGIN,
    username: REVIEW_USERNAME, passwordSha256: PASSWORD_SHA256, stateDirectory, now });
  socket = createSocketServer({ publicOrigin: SOCKET_ORIGIN, stateDirectory, now,
    runtimeGrants: [{ runtimeId: 'review-computer', tokenSha256: digestToken(RUNTIME_TOKEN) }] });
  const address = await portal.listen(0);
  const socketAddress = await socket.listen(0);
  const portalRequest = (path = '/review', options) => request(address.port, REVIEW_ORIGIN, path, options);
  return {
    operator, now, advance(milliseconds) { time += milliseconds; },
    request: portalRequest,
    async csrf(options) {
      const response = await portalRequest('/review', options);
      assert.equal(response.status, 200);
      return csrfFromHtml(response.text);
    },
    post(csrf, options = {}) {
      return portalRequest('/review/pair', { method: 'POST', form: { csrf }, ...options,
        headers: { origin: REVIEW_ORIGIN, ...options.headers } });
    },
    socketRequest(path, options = {}) { return request(socketAddress.port, SOCKET_ORIGIN, path, { auth: null, ...options }); },
    async redeem(pairing) {
      const response = await request(socketAddress.port, SOCKET_ORIGIN, '/v2/pairing/redeem', {
        method: 'POST', auth: null, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId: pairing.pairingId, code: pairing.code, deviceName: 'Local review phone' }),
      });
      return { ...response, body: JSON.parse(response.text) };
    },
    pending() {
      const db = new DatabaseSync(join(stateDirectory, 'auth.sqlite3'), { readOnly: true });
      try { return db.prepare('SELECT id, expires_at, attempts FROM pairing').all().map(row => ({ ...row })); }
      finally { db.close(); }
    },
    pairingLifetime: 5 * MINUTE,
  };
}

function decodeHtml(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function csrfFromHtml(html) {
  const input = html.match(/<input\b[^>]*\bname=["']csrf["'][^>]*>/i)?.[0];
  const token = input?.match(/\bvalue=(["'])(.*?)\1/)?.[2];
  assert.ok(token, 'GET form must contain a CSRF value');
  return decodeHtml(token);
}

export function pairingFromHtml(html) {
  const field = id => {
    const match = html.match(new RegExp(`<(?:dd|span)\\b[^>]*\\bid=["']${id}["'][^>]*>([^<]*)<\\/(?:dd|span)>`, 'i'));
    assert.ok(match, `Missing manual pairing field ${id}`);
    return decodeHtml(match[1].trim());
  };
  return { serverUrl: field('pairing-server-url'), pairingId: field('pairing-id'),
    code: field('pairing-code'), expiresAt: Number(field('pairing-expires-at')) };
}
