import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/auth.mjs';
import { ownershipFixture, seedOwnership, competingOwnershipWorker } from './request-ownership-fixture.mjs';

const RETENTION = 12 * 60 * 60 * 1000;
const rowCount = database => database.prepare('SELECT count(*) AS count FROM request_ownership').get().count;

test('routing identity survives reopen without retaining content or mutable caller references', t => {
  const f = ownershipFixture(t);
  const identity = f.identity({ content: 'not stored', approval: { approved: true } });
  const expected = { ...f.identity(), status: 'open', createdAt: f.now(), terminalAt: null };
  const result = f.store.create(identity);
  assert.deepEqual(result, expected);
  result.subject = 'changed'; identity.sessionId = 'changed';
  assert.deepEqual(f.store.get('runtime', 'request'), expected);
  f.database.close();
  const reopened = f.open();
  assert.deepEqual(reopened.store.get('runtime', 'request'), expected);
  assert.equal(reopened.store.get('other-runtime', 'request'), null);
  assert.deepEqual(reopened.database.prepare('PRAGMA table_info(request_ownership)').all().map(row => row.name),
    ['runtime_id', 'request_id', 'session_id', 'subject', 'device_id', 'status', 'created_at', 'terminal_at']);
});

test('invalid routing identities fail before persistence and the table rejects invalid lifecycle values', t => {
  const f = ownershipFixture(t);
  for (const extra of [{ subject: 'another-owner' }, { deviceId: '' }, { deviceId: 'x'.repeat(257) },
    { runtimeId: '../runtime' }, { requestId: '' }, { sessionId: 'x'.repeat(129) }]) {
    assert.throws(() => f.store.create(f.identity(extra)), { code: 'invalid_request_identity' });
  }
  assert.equal(rowCount(f.database), 0);
  f.store.create(f.identity());
  assert.throws(() => f.database.prepare("UPDATE request_ownership SET status = 'approved'").run());
  assert.throws(() => f.database.prepare("UPDATE request_ownership SET status = 'terminal'").run());
  assert.throws(() => f.database.prepare("UPDATE request_ownership SET created_at = 'not-a-number'").run());
  assert.equal(f.store.get('runtime', 'request').status, 'open');
});

test('duplicate request admission never overwrites identity, including terminal records', t => {
  const f = ownershipFixture(t); const original = f.store.create(f.identity());
  for (const extra of [{}, { deviceId: 'second-device' }, { sessionId: 'other-session' }])
    assert.throws(() => f.store.create(f.identity(extra)), { code: 'request_id_conflict' });
  assert.deepEqual(f.store.get('runtime', 'request'), original);
  assert.equal(f.store.markTerminal('runtime', 'request'), true);
  assert.throws(() => f.store.create(f.identity()), { code: 'request_id_conflict' });
  assert.equal(f.store.create(f.identity({ runtimeId: 'other-runtime' })).status, 'open');
});

test('indefinite open records survive aging and only terminal records expire after twelve hours', t => {
  const f = ownershipFixture(t);
  f.store.create(f.identity()); f.store.create(f.identity({ requestId: 'done' }));
  assert.equal(f.store.markTerminal('runtime', 'done'), true);
  const terminalAt = f.store.get('runtime', 'done').terminalAt;
  f.advance(RETENTION - 1);
  assert.equal(f.store.markTerminal('runtime', 'done'), false);
  assert.equal(f.store.markTerminal('runtime', 'missing'), false);
  assert.equal(f.store.get('runtime', 'done').terminalAt, terminalAt);
  assert.equal(f.store.prune(), 0);
  f.advance(1); assert.equal(f.store.prune(), 1);
  assert.equal(f.store.get('runtime', 'done'), null);
  f.advance(10 * 365 * 24 * 60 * 60 * 1000);
  assert.equal(f.store.prune(), 0);
  assert.equal(f.store.get('runtime', 'request').status, 'open');
});

test('full capacity rejects new work without evicting open records, then reuses an expired terminal slot', t => {
  const f = ownershipFixture(t); seedOwnership(f, 512);
  f.advance(100 * RETENTION);
  assert.throws(() => f.store.create(f.identity()), { code: 'request_capacity' });
  assert.equal(rowCount(f.database), 512);
  f.store.markTerminal('runtime', 'seed-0'); f.advance(RETENTION);
  f.store.create(f.identity());
  assert.equal(rowCount(f.database), 512);
  assert.equal(f.store.get('runtime', 'seed-0'), null);
  assert.equal(f.store.get('runtime', 'seed-511').status, 'open');
});

test('failed admission rolls back terminal pruning and leaves existing routing intact', t => {
  const f = ownershipFixture(t); const original = f.store.create(f.identity());
  f.store.markTerminal('runtime', 'request'); f.advance(RETENTION);
  f.database.prepare(`CREATE TRIGGER fail_ownership_insert BEFORE INSERT ON request_ownership
    BEGIN SELECT RAISE(ABORT, 'fixture-write-failure'); END`).run();
  assert.throws(() => f.store.create(f.identity({ requestId: 'new' })), /fixture-write-failure/);
  assert.equal(rowCount(f.database), 1);
  assert.equal(f.store.get('runtime', 'request').subject, original.subject);
  assert.equal(f.store.get('runtime', 'new'), null);
});

test('whole-session retirement is scoped to the exact runtime and session', t => {
  const f = ownershipFixture(t);
  f.store.create(f.identity());
  f.store.create(f.identity({ requestId: 'sibling' }));
  f.store.create(f.identity({ sessionId: 'other-session', requestId: 'other-request' }));
  f.store.create(f.identity({ runtimeId: 'other-runtime' }));
  assert.equal(f.store.retireSession('runtime', 'session'), 2);
  assert.equal(f.store.retireSession('runtime', 'session'), 0);
  assert.equal(rowCount(f.database), 2);
  assert.ok(f.store.get('runtime', 'other-request'));
  assert.ok(f.store.get('other-runtime', 'request'));
});

test('session inspection returns only detached exact-scope records in stable order', t => {
  const f = ownershipFixture(t);
  f.store.create(f.identity({ requestId: 'z' }));
  f.store.create(f.identity({ requestId: 'a' }));
  f.store.create(f.identity({ sessionId: 'other-session' }));
  f.store.create(f.identity({ runtimeId: 'other-runtime' }));
  f.advance(1); f.store.create(f.identity({ requestId: 'b' }));
  f.store.markTerminal('runtime', 'a');
  const records = f.store.listSession('runtime', 'session');
  assert.deepEqual(records.map(record => record.requestId), ['a', 'z', 'b']);
  assert.equal(records[0].status, 'terminal');
  records[0].status = 'open';
  assert.equal(f.store.get('runtime', 'a').status, 'terminal');
  assert.deepEqual(f.store.listSession('runtime', 'missing'), []);
});

test('origin-device revocation and expiry preserve owner routing but invalidate that device', t => {
  const f = ownershipFixture(t); const auth = new AuthService({ database: f.database, now: f.now });
  t.after(() => auth.close());
  const first = auth.redeemPairing(auth.createPairing(), 'first-device');
  const second = auth.redeemPairing(auth.createPairing(), 'second-device');
  f.store.create(f.identity({ deviceId: first.session.id }));
  auth.revokeDevice(first.session.id);
  assert.equal(auth.authenticate(first.token), null);
  assert.equal(auth.authenticate(second.token).subject, f.store.get('runtime', 'request').subject);
  f.advance(31 * 24 * 60 * 60 * 1000); auth.prune();
  assert.equal(auth.authenticate(second.token), null);
  assert.equal(f.store.get('runtime', 'request').deviceId, first.session.id);
});

for (const scenario of ['same-request', 'last-slot']) {
  test(`independent SQLite connections serialize ${scenario} admission`, { timeout: 15_000 }, async t => {
    const f = ownershipFixture(t);
    if (scenario === 'last-slot') seedOwnership(f, 511);
    const peers = [0, 1].map(index => competingOwnershipWorker(f.stateDirectory,
      f.identity({ requestId: scenario === 'same-request' ? 'request' : `contender-${index}` }), f.now()));
    try {
      await Promise.all(peers.map(peer => peer.ready));
      for (const { worker } of peers) worker.postMessage('create');
      const outcomes = await Promise.all(peers.map(peer => peer.outcome));
      assert.equal(outcomes.filter(result => result.ok).length, 1);
      assert.deepEqual(outcomes.filter(result => !result.ok).map(result => result.code),
        [scenario === 'same-request' ? 'request_id_conflict' : 'request_capacity']);
      assert.equal(rowCount(f.database), scenario === 'same-request' ? 1 : 512);
    } finally { await Promise.all(peers.map(peer => peer.worker.terminate())); }
  });
}
