import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { AuthService } from '../src/auth/auth.mjs';
import { ownershipFixture } from './request-ownership-fixture.mjs';

const BASE_TABLES = ['metadata', 'pairing', 'devices', 'pairing_attempts'];
const NOTIFICATION_TABLES = ['notifications', 'notification_registrations', 'notification_outbox'];
const rows = (database, table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

function seedExistingState(f) {
  const auth = new AuthService({ database: f.database, now: f.now });
  const device = auth.redeemPairing(auth.createPairing(), 'migration-fixture');
  const pending = auth.createPairing();
  f.database.prepare(`INSERT INTO notifications
    (id, device_id, runtime_id, session_id, request_id, kind, created_at, expires_at)
    VALUES ('notification', ?, 'runtime', 'session', 'request', 'completed', ?, ?)`)
    .run(device.session.id, f.now(), f.now() + 60_000);
  f.database.prepare(`INSERT INTO notification_registrations(device_id, provider, registration, updated_at)
    VALUES (?, 'fcm', 'fixture-registration', ?)`).run(device.session.id, f.now());
  f.database.prepare(`INSERT INTO notification_outbox(notification_id, attempts, next_at, encrypted_preview)
    VALUES ('notification', 2, ?, 'fixture-ciphertext')`).run(f.now() + 1000);
  f.database.prepare('INSERT INTO notification_preview_keys(device_id, key_id, key_bytes) VALUES (?, ?, ?)')
    .run(device.session.id, 'fixture-key', Buffer.alloc(32, 7));
  auth.close();
  return { device, pending };
}

/** Recreate each prior schema by removing only tables/columns introduced later. */
function downgradeFixture(database, version) {
  database.prepare('DROP TABLE request_ownership').run();
  if (version < 3) database.prepare('DROP TABLE notification_preview_keys').run();
  if (version === 2) database.prepare('ALTER TABLE notification_outbox DROP COLUMN encrypted_preview').run();
  if (version === 1) {
    for (const table of ['notification_outbox', 'notification_registrations', 'notifications'])
      database.prepare(`DROP TABLE ${table}`).run();
  }
  database.prepare(`PRAGMA user_version = ${version}`).run();
}

for (const version of [1, 2, 3]) {
  test(`schema v${version} upgrades atomically with auth and existing delivery state unchanged`, t => {
    const f = ownershipFixture(t);
    const { device, pending } = seedExistingState(f);
    downgradeFixture(f.database, version);
    const tables = [...BASE_TABLES, ...(version >= 2 ? NOTIFICATION_TABLES : []),
      ...(version === 3 ? ['notification_preview_keys'] : [])];
    const snapshots = new Map(tables.map(table => [table, rows(f.database, table)]));
    const owner = f.database.ownerId; const salt = f.database.tokenSalt;
    f.database.close();
    const { database, store } = f.open();
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(database.ownerId, owner); assert.equal(database.tokenSalt, salt);
    for (const [table, before] of snapshots) {
      const after = rows(database, table);
      if (version === 2 && table === 'notification_outbox') {
        assert.deepEqual(after.map(({ encrypted_preview, ...record }) => record), before.map(record => ({ ...record })));
        assert.equal(after[0].encrypted_preview, null);
      } else assert.deepEqual(after, before);
    }
    const schema = database.prepare('PRAGMA table_list').all().find(row => row.name === 'request_ownership');
    assert.equal(schema.strict, 1);
    assert.deepEqual(store.listSession('runtime', 'session'), []);
    const auth = new AuthService({ database, now: f.now });
    try {
      assert.equal(auth.authenticate(device.token).sessionId, device.session.id);
      assert.ok(auth.redeemPairing(pending, 'migration-fixture').token);
    } finally { auth.close(); }
    const record = store.create(f.identity());
    const reopened = f.open();
    assert.deepEqual(reopened.store.get('runtime', 'request'), record);
    assert.equal(reopened.database.prepare('PRAGMA user_version').get().user_version, 4);
  });
}

test('failed schema migration rolls back newly created tables and preserves prior data and version', t => {
  const f = ownershipFixture(t); seedExistingState(f);
  downgradeFixture(f.database, 1);
  f.database.prepare('CREATE TABLE request_ownership (sentinel TEXT NOT NULL) STRICT').run();
  f.database.prepare("INSERT INTO request_ownership VALUES ('preserved')").run();
  const metadata = rows(f.database, 'metadata'); const devices = rows(f.database, 'devices');
  assert.throws(() => new AuthDatabase(f.stateDirectory), /request_ownership.*already exists/);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(rows(f.database, 'metadata'), metadata);
  assert.deepEqual(rows(f.database, 'devices'), devices);
  assert.equal(rows(f.database, 'request_ownership')[0].sentinel, 'preserved');
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'notifications'").get().count, 0);
});

test('a future schema is rejected without downgrading state', t => {
  const f = ownershipFixture(t); const record = f.store.create(f.identity());
  f.database.prepare('PRAGMA user_version = 5').run();
  assert.throws(() => new AuthDatabase(f.stateDirectory), /Unrecognized authentication database/);
  assert.equal(f.database.prepare('PRAGMA user_version').get().user_version, 5);
  assert.deepEqual(f.store.get('runtime', 'request'), record);
});
