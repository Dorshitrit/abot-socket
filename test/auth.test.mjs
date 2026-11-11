import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/auth/auth.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SOURCE = '127.0.0.20';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-pairing-')));
  const stateDirectory = join(root, 'state');
  let time = 1_000_000;
  const connections = [];
  const open = () => {
    const auth = new AuthService({ stateDirectory, now: () => time });
    connections.push(auth);
    return auth;
  };
  t.after(() => {
    for (const auth of connections) auth.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { auth: open(), open, stateDirectory, advance(ms) { time += ms; } };
}

function rejectsCode(fn, code = 'invalid_code', status = 401) {
  assert.throws(fn, (error) => error.code === code && error.status === status);
}
function pair(auth, deviceName = 'Test phone') {
  return auth.redeemPairing({ ...auth.createPairing(), deviceName }, SOURCE);
}

test('local pairing returns a six-digit code and stable owner with independent opaque device tokens', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  assert.match(pairing.pairingId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(pairing.code, /^\d{6}$/);
  assert.equal(pairing.expiresAt, 1_300_000);
  const result = f.auth.redeemPairing({ ...pairing, deviceName: ' Phone ' }, SOURCE);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.session.subject, /^[a-f0-9-]{36}$/);
  assert.equal(result.session.deviceName, 'Phone');
  assert.equal(result.expiresAt, 1_000_000 + 30 * DAY);
  const principal = f.auth.authenticate(result.token);
  assert.equal(principal.sessionId, result.session.id);
  assert.ok(Object.isFrozen(principal));
  rejectsCode(() => f.auth.redeemPairing(pairing, SOURCE));
  const second = pair(f.auth, 'Tablet');
  assert.equal(second.session.subject, result.session.subject);
  assert.notEqual(second.token, result.token);
  assert.notEqual(second.session.id, result.session.id);
});

test('five wrong guesses including malformed codes lock a challenge across reopen', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  for (let i = 0; i < 4; i++) rejectsCode(() => f.auth.redeemPairing({ ...pairing, code: 'bad' }, SOURCE));
  f.auth.close();
  const reopened = f.open();
  rejectsCode(() => reopened.redeemPairing({ ...pairing, code: 'bad' }, SOURCE));
  rejectsCode(() => reopened.redeemPairing(pairing, SOURCE));
  assert.equal(reopened.listDevices().length, 0);
});

test('a pairing expires exactly five minutes after creation, including after reopen', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  f.auth.close(); f.advance(5 * MINUTE);
  rejectsCode(() => f.open().redeemPairing(pairing, SOURCE));
});

test('regeneration invalidates only the pending challenge and keeps paired devices', (t) => {
  const f = fixture(t);
  const device = pair(f.auth);
  const first = f.auth.createPairing();
  const second = f.auth.createPairing();
  assert.notEqual(second.pairingId, first.pairingId);
  rejectsCode(() => f.auth.redeemPairing(first, SOURCE));
  assert.ok(f.auth.authenticate(device.token));
  assert.ok(f.auth.redeemPairing(second, SOURCE).token);
});

test('unknown pairing identifiers do not consume attempts on the pending challenge', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  for (let i = 0; i < 6; i++) rejectsCode(() => f.auth.redeemPairing({ ...pairing, pairingId: 'x'.repeat(32) }, SOURCE));
  assert.ok(f.auth.redeemPairing(pairing, SOURCE).token);
});

test('invalid device names are rejected before consuming the pairing', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  for (const deviceName of [null, '', '  ', 'x'.repeat(81), 'bad\nname', {}]) {
    rejectsCode(() => f.auth.redeemPairing({ ...pairing, deviceName }, SOURCE), 'invalid_request', 400);
  }
  assert.ok(f.auth.redeemPairing({ ...pairing, deviceName: 'Phone' }, SOURCE).token);
});

test('unrelated requests cannot exhaust verification limits before valid enrollment', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  const second = f.open();
  for (let i = 0; i < 120; i++) {
    const auth = i % 2 ? f.auth : second;
    const source = i < 30 ? SOURCE : `unrelated-source-${i}`;
    rejectsCode(() => auth.redeemPairing(null, source));
    rejectsCode(() => auth.redeemPairing({}, source));
    rejectsCode(() => auth.redeemPairing({ ...pairing, pairingId: 'invalid' }, source));
    rejectsCode(() => auth.redeemPairing({ ...pairing, pairingId: 'x'.repeat(32) }, source));
    rejectsCode(() => auth.redeemPairing({ ...pairing, deviceName: '' }, source), 'invalid_request', 400);
  }
  f.auth.close(); second.close();
  const reopened = f.open();
  const device = reopened.redeemPairing(pairing, SOURCE);
  assert.ok(reopened.authenticate(device.token));
  assert.ok(reopened.redeemPairing(reopened.createPairing(), 'fresh-source').token);
});

test('expired and replaced pairing keys cannot spend a current pairing verification quota', (t) => {
  const f = fixture(t);
  const expired = f.auth.createPairing();
  f.advance(5 * MINUTE);
  for (let i = 0; i < 30; i++) rejectsCode(() => f.auth.redeemPairing(expired, SOURCE));
  const replaced = f.auth.createPairing();
  const current = f.auth.createPairing();
  for (let i = 0; i < 100; i++) rejectsCode(() => f.auth.redeemPairing(replaced, `source-${i}`));
  assert.ok(f.open().redeemPairing(current, SOURCE).token);
});

test('a locked challenge cannot exhaust the quota for a replacement challenge', (t) => {
  const f = fixture(t);
  const pairing = f.auth.createPairing();
  for (let i = 0; i < 5; i++) rejectsCode(() => f.auth.redeemPairing({ ...pairing, code: 'bad' }, SOURCE));
  for (let i = 0; i < 100; i++) rejectsCode(() => f.auth.redeemPairing(pairing, SOURCE));
  f.auth.close();
  const reopened = f.open();
  rejectsCode(() => reopened.redeemPairing(pairing, SOURCE));
  assert.ok(reopened.redeemPairing(reopened.createPairing(), SOURCE).token);
});

test('per-source verification limits persist across challenges and connections and expire', (t) => {
  const f = fixture(t);
  for (let challenge = 0; challenge < 4; challenge++) {
    const pairing = f.auth.createPairing();
    for (let i = 0; i < 5; i++) rejectsCode(() => f.auth.redeemPairing({ ...pairing, code: 'bad' }, SOURCE));
  }
  const second = f.open();
  const pairing = second.createPairing();
  rejectsCode(() => second.redeemPairing(pairing, SOURCE), 'rate_limited', 429);
  assert.ok(second.redeemPairing(pairing, 'another-source').token);
  f.advance(15 * MINUTE);
  assert.ok(second.redeemPairing(second.createPairing(), SOURCE).token);
});

test('global verification limits block source rotation across challenges and connections', (t) => {
  const f = fixture(t);
  const second = f.open();
  for (let challenge = 0; challenge < 20; challenge++) {
    const pairing = f.auth.createPairing();
    for (let i = 0; i < 5; i++) {
      const auth = i % 2 ? f.auth : second;
      rejectsCode(() => auth.redeemPairing({ ...pairing, code: 'bad' }, `source-${challenge * 5 + i}`));
    }
  }
  const pairing = second.createPairing();
  f.auth.close(); second.close();
  const reopened = f.open();
  rejectsCode(() => reopened.redeemPairing(pairing, 'new-source'), 'rate_limited', 429);
  f.advance(15 * MINUTE);
  assert.ok(reopened.redeemPairing(reopened.createPairing(), 'new-source').token);
});

test('ten active devices fail explicitly without revoking or consuming the pending pairing', (t) => {
  const f = fixture(t);
  const devices = Array.from({ length: 10 }, (_, i) => pair(f.auth, `Device ${i}`));
  const pairing = f.auth.createPairing();
  rejectsCode(() => f.auth.redeemPairing(pairing, SOURCE), 'device_limit', 429);
  assert.equal(f.auth.listDevices().length, 10);
  assert.ok(f.auth.authenticate(devices[0].token));
  assert.equal(f.auth.revokeDevice(devices[0].session.id), true);
  assert.ok(f.auth.redeemPairing(pairing, SOURCE).token);
});

test('device lists expose no secrets and listener failure cannot defeat revocation', (t) => {
  const f = fixture(t);
  const first = pair(f.auth, 'Phone');
  const second = pair(f.auth, 'Tablet');
  const principal = f.auth.authenticate(first.token);
  const records = f.auth.listSessions(principal);
  assert.equal(records.length, 2);
  assert.equal(records.filter((record) => record.current).length, 1);
  assert.ok(records.every((record) => Object.keys(record).sort().join(',') === 'createdAt,current,deviceName,expiresAt,id'));
  const revoked = [];
  f.auth.subscribeRevocations(() => { throw new Error('Listener failure'); });
  f.auth.subscribeRevocations((id) => revoked.push(id));
  assert.equal(f.auth.revoke(principal, second.session.id), true);
  assert.equal(f.auth.authenticate(second.token), null);
  assert.equal(f.auth.revoke(principal, second.session.id), false);
  assert.deepEqual(revoked, [second.session.id]);
});

test('30-day expiry is fixed and rejects old principals while notifying once', (t) => {
  const f = fixture(t);
  const session = pair(f.auth);
  const principal = f.auth.authenticate(session.token);
  const revoked = [];
  f.auth.subscribeRevocations((id) => revoked.push(id));
  f.advance(30 * DAY - 1);
  assert.equal(f.auth.authenticate(session.token).expiresAt, session.expiresAt);
  f.advance(1); f.auth.prune(); f.auth.prune();
  assert.equal(f.auth.authenticate(session.token), null);
  assert.deepEqual(revoked, [session.session.id]);
  rejectsCode(() => f.auth.listSessions(principal), 'unauthorized', 401);
});

test('unknown tokens and manufactured or foreign-connection principals are rejected', (t) => {
  const f = fixture(t);
  const session = pair(f.auth);
  for (const token of [null, {}, '', 'x'.repeat(100_000), 'a'.repeat(43)]) assert.equal(f.auth.authenticate(token), null);
  rejectsCode(() => f.auth.listSessions({ sessionId: session.session.id, subject: session.session.subject }), 'unauthorized', 401);
  rejectsCode(() => f.auth.revoke(null, session.session.id), 'unauthorized', 401);
  rejectsCode(() => f.open().listSessions(f.auth.authenticate(session.token)), 'unauthorized', 401);
});

test('tokens and owner survive restart and external revocation invalidates live principals', (t) => {
  const f = fixture(t);
  const device = pair(f.auth); f.auth.close();
  const relay = f.open();
  const principal = relay.authenticate(device.token);
  assert.equal(principal.subject, device.session.subject);
  const operator = f.open();
  const revoked = [];
  relay.subscribeRevocations((id) => revoked.push(id));
  assert.equal(operator.revokeDevice(device.session.id), true);
  assert.equal(relay.authenticate(device.token), null);
  assert.deepEqual(revoked, [device.session.id]);
  rejectsCode(() => relay.revoke(principal, device.session.id), 'unauthorized', 401);
  operator.close();
  assert.equal(f.open().authenticate(device.token), null);
});
