import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { ownershipFixture, seedOwnership } from './request-ownership-fixture.mjs';

const RETENTION = 12 * 60 * 60 * 1000;
const rowCount = database => database.prepare('SELECT count(*) AS count FROM request_ownership').get().count;

test('first adoption persists only the verified routing identity across reopen', t => {
  const f = ownershipFixture(t);
  const identity = f.identity({ content: 'not retained', approval: { approved: true } });
  const expected = { ...f.identity(), status: 'open', createdAt: f.now(), terminalAt: null };
  const adopted = f.store.adopt(identity);
  assert.deepEqual(adopted, expected);
  assert.equal(rowCount(f.database), 1);
  adopted.deviceId = 'changed-return-value';
  identity.sessionId = 'changed-input';
  assert.deepEqual(f.store.get('runtime', 'request'), expected);
  f.database.close();
  const reopened = f.open();
  assert.deepEqual(reopened.store.get('runtime', 'request'), expected);
  assert.equal(reopened.database.prepare('PRAGMA user_version').get().user_version, 4);
});

test('same-owner same-session adoption is idempotent and keeps the original device and lifecycle', t => {
  const f = ownershipFixture(t);
  const original = f.store.create(f.identity({ deviceId: 'original-device' }));
  f.advance(5000);
  assert.deepEqual(f.store.adopt(f.identity({ deviceId: 'new-device' })), original);
  assert.deepEqual(f.store.adopt(f.identity({ deviceId: 'new-device' }), true), original);
  assert.equal(rowCount(f.database), 1);
  f.store.markTerminal('runtime', 'request');
  const terminal = f.store.get('runtime', 'request');
  f.advance(1000);
  assert.deepEqual(f.store.adopt(f.identity({ deviceId: 'third-device' })), terminal);
});

test('adoption rejects foreign subject and session without overwriting a binding', t => {
  const f = ownershipFixture(t);
  assert.throws(() => f.store.adopt(f.identity({ subject: 'foreign-owner' })),
    { code: 'invalid_request_identity' });
  assert.throws(() => f.store.adopt(f.identity(), 'terminal'),
    { code: 'invalid_request_identity' });
  assert.equal(rowCount(f.database), 0);
  const original = f.store.adopt(f.identity());
  assert.throws(() => f.store.adopt(f.identity({ sessionId: 'different-session' })),
    { code: 'request_not_owned' });
  assert.deepEqual(f.store.get('runtime', 'request'), original);
  f.database.prepare('UPDATE request_ownership SET subject = ? WHERE request_id = ?')
    .run('foreign-owner', 'request');
  const foreign = f.store.get('runtime', 'request');
  assert.throws(() => f.store.adopt(f.identity()), { code: 'request_not_owned' });
  assert.deepEqual(f.store.get('runtime', 'request'), foreign);
  assert.equal(rowCount(f.database), 1);
});

test('terminal adoption starts retention without expiring open adopted work', t => {
  const f = ownershipFixture(t);
  const open = f.store.adopt(f.identity());
  const terminal = f.store.adopt(f.identity({ requestId: 'already-completed' }), true);
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.terminalAt, f.now());
  f.advance(RETENTION - 1);
  assert.equal(f.store.prune(), 0);
  f.advance(1);
  assert.equal(f.store.prune(), 1);
  assert.equal(f.store.get('runtime', 'already-completed'), null);
  assert.deepEqual(f.store.get('runtime', 'request'), open);
});

test('adoption at capacity preserves existing records and reuses only expired terminal slots', t => {
  const f = ownershipFixture(t);
  seedOwnership(f, 512);
  const existing = f.store.get('runtime', 'seed-0');
  assert.deepEqual(f.store.adopt(f.identity({ requestId: 'seed-0', deviceId: 'other-device' })), existing);
  assert.throws(() => f.store.adopt(f.identity()), { code: 'request_capacity' });
  assert.equal(rowCount(f.database), 512);
  assert.equal(f.store.get('runtime', 'request'), null);
  f.store.markTerminal('runtime', 'seed-1');
  f.advance(RETENTION);
  assert.equal(f.store.adopt(f.identity()).status, 'open');
  assert.equal(rowCount(f.database), 512);
  assert.equal(f.store.get('runtime', 'seed-1'), null);
  assert.deepEqual(f.store.get('runtime', 'seed-0'), existing);
});

test('failed first adoption rolls back pruning and leaves no partial binding', t => {
  const f = ownershipFixture(t);
  f.store.adopt(f.identity({ requestId: 'expired' }), true);
  const original = f.store.get('runtime', 'expired');
  f.advance(RETENTION);
  f.database.prepare(`CREATE TRIGGER fail_adoption BEFORE INSERT ON request_ownership
    BEGIN SELECT RAISE(ABORT, 'adoption-fixture-failure'); END`).run();
  assert.throws(() => f.store.adopt(f.identity()), /adoption-fixture-failure/);
  assert.equal(f.store.get('runtime', 'request'), null);
  assert.deepEqual(f.store.get('runtime', 'expired'), original);
  assert.equal(rowCount(f.database), 1);
});

for (const scenario of ['same-session', 'conflicting-session', 'last-slot']) {
  test(`independent SQLite connections serialize ${scenario} adoption`, { timeout: 15_000 }, async t => {
    const f = ownershipFixture(t);
    if (scenario === 'last-slot') seedOwnership(f, 511);
    const peers = [0, 1].map(index => adoptionWorker(f.stateDirectory, f.identity({
      requestId: scenario === 'last-slot' ? `contender-${index}` : 'request',
      sessionId: scenario === 'conflicting-session' ? `session-${index}` : 'session',
      deviceId: `device-${index}`,
    }), f.now()));
    try {
      await Promise.all(peers.map(peer => peer.ready));
      for (const { worker } of peers) worker.postMessage('adopt');
      const outcomes = await Promise.all(peers.map(peer => peer.outcome));
      const successes = outcomes.filter(result => result.ok);
      if (scenario === 'same-session') {
        assert.equal(successes.length, 2);
        assert.deepEqual(successes[0].record, successes[1].record);
        assert.ok(['device-0', 'device-1'].includes(successes[0].record.deviceId));
        assert.deepEqual(f.store.get('runtime', 'request'), successes[0].record);
      } else {
        assert.equal(successes.length, 1);
        assert.deepEqual(outcomes.filter(result => !result.ok).map(result => result.code),
          [scenario === 'last-slot' ? 'request_capacity' : 'request_not_owned']);
        assert.deepEqual(f.store.get('runtime', successes[0].record.requestId), successes[0].record);
      }
      assert.equal(rowCount(f.database), scenario === 'last-slot' ? 512 : 1);
    } finally {
      await Promise.all(peers.map(peer => peer.worker.terminate()));
    }
  });
}

function adoptionWorker(stateDirectory, identity, time) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.databaseURL), import(workerData.storeURL)]).then(([a, s]) => {
      const database = new a.AuthDatabase(workerData.stateDirectory);
      const store = new s.RequestOwnershipStore({ database, now: () => workerData.time });
      parentPort.postMessage({ ready: true });
      parentPort.once('message', () => {
        try {
          const record = store.adopt(workerData.identity);
          parentPort.postMessage({ ok: true, record });
        } catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
        finally { database.close(); }
      });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { stateDirectory, identity, time,
    databaseURL: new URL('../src/auth/auth-database.mjs', import.meta.url).href,
    storeURL: new URL('../src/relay/request-ownership-store.mjs', import.meta.url).href } });
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => { if (message.ready) resolve(); });
  });
  const outcome = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => { if ('ok' in message) resolve(message); });
  });
  // A startup failure may arrive while the caller is still awaiting readiness.
  outcome.catch(() => {});
  return { worker, ready, outcome };
}
