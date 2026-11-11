import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC, PASSWORD_SHA256, REVIEW_ORIGIN, REVIEW_PASSWORD, RUNTIME_TOKEN, SOCKET_ORIGIN,
  WRONG_BASIC, pairingFromHtml, reviewPortalFixture } from './review-portal-fixture.mjs';

function privateResponse(response) {
  assert.match(response.headers['cache-control'], /(?:^|,)\s*no-store(?:,|$)/);
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers.location, undefined);
  const serialized = response.text + JSON.stringify(response.headers);
  for (const secret of [REVIEW_PASSWORD, PASSWORD_SHA256, RUNTIME_TOKEN, BASIC]) {
    assert.ok(!serialized.includes(secret), 'Response must not expose operator/runtime secrets');
  }
  if (response.status >= 400) {
    assert.match(response.text, /<a\b[^>]*href=["']\/review["']/);
    assert.doesNotMatch(response.text, /<form\b|name=["']csrf["']/);
  }
}

test('portal requires Basic authentication and GET never issues or replaces a pairing', async t => {
  const f = await reviewPortalFixture(t);
  for (const auth of [null, WRONG_BASIC, 'Bearer not-a-reviewer-credential', 'Basic !!!']) {
    const denied = await f.request('/review', { auth });
    assert.equal(denied.status, 401);
    assert.match(denied.headers['www-authenticate'], /^Basic /);
    privateResponse(denied);
  }
  assert.deepEqual(f.pending(), []);
  const landing = await f.request();
  assert.equal(landing.status, 200);
  privateResponse(landing);
  assert.doesNotMatch(landing.text, /id=["']pairing-code["']/);
  assert.deepEqual(f.pending(), []);
  const existing = f.operator.createPairing();
  const before = f.pending();
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.pending(), before);
  assert.ok(f.operator.redeemPairing(existing, 'local-operator').token);
});

test('ordinary Socket listener has no default review portal or create-pairing route', async t => {
  const f = await reviewPortalFixture(t);
  for (const path of ['/review', '/review/pair']) {
    assert.equal((await f.socketRequest(path)).status, 401);
  }
  assert.equal((await f.socketRequest('/review/pair', { method: 'POST', form: { csrf: 'dummy' } })).status, 401);
  assert.deepEqual(f.pending(), []);
  const device = f.operator.redeemPairing(f.operator.createPairing(), 'normal-device');
  f.operator.createPairing();
  const pending = f.pending();
  const auth = `Bearer ${device.token}`;
  for (const path of ['/review', '/review/pair']) {
    assert.equal((await f.socketRequest(path, { auth })).status, 404);
  }
  assert.equal((await f.socketRequest('/review/pair', { auth, method: 'POST', form: { csrf: 'dummy' } })).status, 404);
  assert.deepEqual(f.pending(), pending);
  assert.equal(f.operator.listDevices().length, 1);
});

test('exact HTTPS authority and verified proxy identity cannot be replaced by forwarded hints', async t => {
  const f = await reviewPortalFixture(t);
  for (const headers of [
    { host: 'attacker.invalid', 'x-forwarded-host': new URL(REVIEW_ORIGIN).host },
    { host: `${new URL(REVIEW_ORIGIN).host}:443` },
    { origin: 'https://attacker.invalid' },
    { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-proto': 'https,http' },
    { 'x-socket-client-ip': undefined, 'x-forwarded-for': '192.0.2.1' },
    { 'x-socket-client-ip': '192.0.2.1, 192.0.2.2' },
    { 'x-socket-client-ip': 'not-an-ip' },
  ]) {
    const denied = await f.request('/review', { headers });
    assert.equal(denied.status, 403);
    privateResponse(denied);
  }
  assert.deepEqual(f.pending(), []);
});

test('pair creation requires Basic, exact Origin and an intact same-process CSRF value', async t => {
  const f = await reviewPortalFixture(t);
  const csrf = await f.csrf();
  for (const options of [
    { auth: null }, { auth: WRONG_BASIC },
    { headers: { origin: undefined } },
    { headers: { origin: 'https://attacker.invalid' } },
    { headers: { origin: `${REVIEW_ORIGIN}/` } },
    { form: {} }, { form: { csrf: 'not-a-token' } },
    { form: { csrf: `${csrf.startsWith('A') ? 'B' : 'A'}${csrf.slice(1)}` } },
  ]) {
    const denied = await f.post(csrf, options);
    assert.ok([400, 401, 403].includes(denied.status));
    privateResponse(denied);
    assert.deepEqual(f.pending(), []);
  }
});

test('CSRF from a different portal process is not accepted even with the same reviewer credentials', async t => {
  const first = await reviewPortalFixture(t);
  const second = await reviewPortalFixture(t);
  const response = await first.post(await second.csrf());
  assert.equal(response.status, 403);
  assert.deepEqual(first.pending(), []);
  assert.deepEqual(second.pending(), []);
});

test('CSRF expires after ten minutes without issuing a pairing', async t => {
  const f = await reviewPortalFixture(t);
  const csrf = await f.csrf();
  f.advance(10 * 60_000);
  const expired = await f.post(csrf);
  assert.equal(expired.status, 403);
  privateResponse(expired);
  assert.deepEqual(f.pending(), []);
  assert.equal((await f.post(await f.csrf())).status, 200);
});

test('URL queries, unsupported methods and GET on the pair route cannot create credentials', async t => {
  const f = await reviewPortalFixture(t);
  for (const [path, options] of [
    ['/review/pair', {}], ['/review', { method: 'POST' }],
    ['/review/pair?csrf=dummy', { method: 'POST', form: { csrf: 'dummy' }, headers: { origin: REVIEW_ORIGIN } }],
    [`/review?password=${REVIEW_PASSWORD}`, { auth: null }],
  ]) {
    const response = await f.request(path, options);
    assert.ok(response.status >= 400);
    privateResponse(response);
  }
  assert.deepEqual(f.pending(), []);
});

test('form schema, content type, declared and streamed body limits reject before DB mutation', async t => {
  const f = await reviewPortalFixture(t);
  const csrf = await f.csrf();
  const cases = [
    [{ body: JSON.stringify({ csrf }), form: undefined, headers: { 'content-type': 'application/json' } }, 415],
    [{ form: { csrf, extra: 'unexpected' } }, 400],
    [{ body: `csrf=${encodeURIComponent(csrf)}&csrf=${encodeURIComponent(csrf)}`, form: undefined,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 400],
    [{ body: `csrf=${'a'.repeat(5000)}`, form: undefined,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 413],
    [{ body: `csrf=${'a'.repeat(5000)}`, form: undefined, chunked: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 413],
  ];
  for (const [options, expected] of cases) {
    const response = await f.post(csrf, options);
    assert.equal(response.status, expected);
    privateResponse(response);
    assert.deepEqual(f.pending(), []);
  }
});

test('successful POST returns local SVG and manual details redeemable only once on normal Socket API', async t => {
  const f = await reviewPortalFixture(t);
  const response = await f.post(await f.csrf());
  assert.equal(response.status, 200);
  privateResponse(response);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.match(response.text, /<svg\b/);
  assert.doesNotMatch(response.text, /<script\b|\bon\w+\s*=|<(?:iframe|img)\b|(?:src|href)=["']https?:/i);
  const pairing = pairingFromHtml(response.text);
  assert.equal(pairing.serverUrl, SOCKET_ORIGIN);
  assert.match(pairing.pairingId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(pairing.code, /^\d{6}$/);
  assert.equal(pairing.expiresAt, f.now() + f.pairingLifetime);
  assert.equal(f.pending().length, 1);
  const login = await f.redeem(pairing);
  assert.equal(login.status, 200);
  assert.ok(f.operator.authenticate(login.body.token));
  assert.equal((await f.redeem(pairing)).status, 401);
});

test('review-issued credentials retain the existing five-minute expiry', async t => {
  const f = await reviewPortalFixture(t);
  const pairing = pairingFromHtml((await f.post(await f.csrf())).text);
  f.advance(f.pairingLifetime);
  assert.equal((await f.redeem(pairing)).status, 401);
  assert.equal(f.operator.listDevices().length, 0);
});

test('new review challenge replaces only pending pairing and preserves already paired devices', async t => {
  const f = await reviewPortalFixture(t);
  const device = f.operator.redeemPairing(f.operator.createPairing(), 'existing-device');
  const csrf = await f.csrf();
  const first = pairingFromHtml((await f.post(csrf)).text);
  const second = pairingFromHtml((await f.post(csrf)).text);
  assert.notEqual(first.pairingId, second.pairingId);
  assert.equal((await f.redeem(first)).status, 401);
  assert.ok(f.operator.authenticate(device.token));
  assert.equal((await f.redeem(second)).status, 200);
  assert.equal(f.operator.listDevices().length, 2);
});

test('per-IP creation quota is five per minute and never replaces a pending code on rejection', async t => {
  const f = await reviewPortalFixture(t);
  const csrf = await f.csrf();
  for (let i = 0; i < 5; i++) assert.equal((await f.post(csrf)).status, 200);
  const before = f.pending();
  const rejected = await f.post(csrf);
  assert.equal(rejected.status, 429);
  privateResponse(rejected);
  assert.deepEqual(f.pending(), before);
  f.advance(60_000);
  assert.equal((await f.post(csrf)).status, 200);
});

test('global creation quota blocks source rotation after twenty pairings per minute', async t => {
  const f = await reviewPortalFixture(t);
  const csrf = await f.csrf();
  for (let i = 0; i < 20; i++) {
    assert.equal((await f.post(csrf, { ip: `192.0.2.${Math.floor(i / 5) + 1}` })).status, 200);
  }
  const before = f.pending();
  assert.equal((await f.post(csrf, { ip: '192.0.2.99' })).status, 429);
  assert.deepEqual(f.pending(), before);
  f.advance(60_000);
  assert.equal((await f.post(csrf, { ip: '192.0.2.99' })).status, 200);
});

test('failed Basic is capped per IP while correct credentials bypass failure quota', async t => {
  const f = await reviewPortalFixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/review', { auth: WRONG_BASIC })).status, 401);
  const blocked = await f.request('/review', { auth: WRONG_BASIC });
  assert.equal(blocked.status, 429);
  privateResponse(blocked);
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.pending(), []);
  f.advance(15 * 60_000);
  assert.equal((await f.request('/review', { auth: WRONG_BASIC })).status, 401);
});

test('failed Basic global quota bounds source rotation without locking out a valid reviewer', async t => {
  const f = await reviewPortalFixture(t);
  for (let i = 0; i < 200; i++) {
    assert.equal((await f.request('/review', { auth: WRONG_BASIC, ip: `192.0.2.${i + 1}` })).status, 401);
  }
  assert.equal((await f.request('/review', { auth: WRONG_BASIC, ip: '192.0.2.201' })).status, 429);
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.pending(), []);
});
