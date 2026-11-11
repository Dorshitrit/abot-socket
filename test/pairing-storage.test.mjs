import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { AuthService } from '../src/auth/auth.mjs';

const AUTH_URL = new URL('../src/auth/auth.mjs', import.meta.url).href;
const TIME = 1_000_000;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-pairing-storage-')));
  const stateDirectory = join(root, 'state');
  const connections = [];
  t.after(() => {
    for (const auth of connections) auth.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, stateDirectory, open() {
    const auth = new AuthService({ stateDirectory, now: () => TIME });
    connections.push(auth); return auth;
  } };
}
function readDatabase(f, inspect) {
  const db = new DatabaseSync(join(f.stateDirectory, 'auth.sqlite3'), { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}

test('state requires an absolute private directory and creates a private database', (t) => {
  const f = fixture(t);
  assert.throws(() => new AuthService(), /stateDirectory/);
  assert.throws(() => new AuthService({ stateDirectory: 'relative' }), /absolute/);
  f.open().createPairing();
  assert.equal(statSync(f.stateDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.stateDirectory, 'auth.sqlite3')).mode & 0o777, 0o600);
});

test('insecure existing directory is rejected without repairing it or creating a database', (t) => {
  const f = fixture(t);
  mkdirSync(f.stateDirectory, { mode: 0o700 }); chmodSync(f.stateDirectory, 0o755);
  assert.throws(() => f.open(), /700/);
  assert.equal(statSync(f.stateDirectory).mode & 0o777, 0o755);
  assert.equal(existsSync(join(f.stateDirectory, 'auth.sqlite3')), false);
});

test('insecure existing database is rejected without changing its permissions', (t) => {
  const f = fixture(t); f.open().close();
  const path = join(f.stateDirectory, 'auth.sqlite3'); chmodSync(path, 0o644);
  assert.throws(() => f.open(), /600/);
  assert.equal(statSync(path).mode & 0o777, 0o644);
});

test('foreign directory entries are rejected and preserved', (t) => {
  const f = fixture(t); mkdirSync(f.stateDirectory, { mode: 0o700 });
  const foreign = join(f.stateDirectory, 'unrelated.txt');
  writeFileSync(foreign, 'preserve me', { mode: 0o600 });
  assert.throws(() => f.open(), /Unexpected authentication state entry/);
  assert.equal(readFileSync(foreign, 'utf8'), 'preserve me');
  assert.equal(existsSync(join(f.stateDirectory, 'auth.sqlite3')), false);
});

test('state directory and ancestor symlinks are rejected before creating files', (t) => {
  const f = fixture(t); const actual = join(f.root, 'actual');
  mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, f.stateDirectory);
  assert.throws(() => f.open(), /symlink/);
  assert.throws(() => new AuthService({ stateDirectory: join(f.stateDirectory, 'child') }), /symlink/);
  assert.equal(existsSync(join(actual, 'auth.sqlite3')), false);
  assert.equal(existsSync(join(actual, 'child')), false);
});

test('database symlinks and hard links are rejected without modifying their targets', (t) => {
  const f = fixture(t); mkdirSync(f.stateDirectory, { mode: 0o700 });
  const target = join(f.root, 'target'); writeFileSync(target, 'foreign file', { mode: 0o600 });
  const database = join(f.stateDirectory, 'auth.sqlite3'); symlinkSync(target, database);
  assert.throws(() => f.open(), /Unsafe authentication state entry/);
  assert.equal(readFileSync(target, 'utf8'), 'foreign file');
  rmSync(database); linkSync(target, database);
  assert.throws(() => f.open(), /multiple links/);
  assert.equal(readFileSync(target, 'utf8'), 'foreign file');
});

test('an unrelated SQLite database is rejected without altering its data', (t) => {
  const f = fixture(t); mkdirSync(f.stateDirectory, { mode: 0o700 });
  const path = join(f.stateDirectory, 'auth.sqlite3');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve');");
  db.close(); chmodSync(path, 0o600);
  const before = readFileSync(path);
  assert.throws(() => f.open(), /Unrecognized authentication database/);
  assert.deepEqual(readFileSync(path), before);
});

test('pairing uses a salted KDF and device storage contains only salted token hashes', (t) => {
  const f = fixture(t); const auth = f.open(); const pairing = auth.createPairing();
  readDatabase(f, (db) => {
    const row = db.prepare('SELECT * FROM pairing').get();
    assert.equal(row.salt.byteLength, 32); assert.equal(row.digest.byteLength, 32);
    assert.deepEqual(Buffer.from(row.digest), scryptSync(pairing.code, row.salt, 32));
    assert.equal('code' in row, false);
  });
  const device = auth.redeemPairing(pairing, 'fixture-source');
  readDatabase(f, (db) => {
    const row = db.prepare('SELECT * FROM devices').get();
    const salt = db.prepare("SELECT value FROM metadata WHERE key = 'token_salt'").get().value;
    assert.equal(row.token_hash, createHash('sha256').update(salt).update(device.token).digest('hex'));
    assert.equal('token' in row, false);
    assert.equal(db.prepare('SELECT count(*) AS count FROM pairing').get().count, 0);
  });
  assert.equal(readFileSync(join(f.stateDirectory, 'auth.sqlite3')).includes(Buffer.from(device.token)), false);
});

test('failure consuming a pairing rolls back credential issuance and leaves pairing usable', (t) => {
  const f = fixture(t); const auth = f.open(); const pairing = auth.createPairing();
  const db = new DatabaseSync(join(f.stateDirectory, 'auth.sqlite3'));
  try {
    db.exec("CREATE TRIGGER deny_consume BEFORE DELETE ON pairing BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    assert.throws(() => auth.redeemPairing(pairing, 'fixture-source'));
    assert.equal(auth.listDevices().length, 0);
    db.exec('DROP TRIGGER deny_consume;');
    assert.ok(auth.redeemPairing(pairing, 'fixture-source').token);
  } finally { db.close(); }
});

function competingWorker(stateDirectory, pairing) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.authURL).then(({ AuthService }) => {
      const auth = new AuthService({ stateDirectory: workerData.stateDirectory, now: () => workerData.time });
      parentPort.postMessage({ ready: true });
      parentPort.once('message', () => {
        try {
          const result = auth.redeemPairing(workerData.pairing, 'worker-fixture');
          parentPort.postMessage({ ok: true, token: result.token });
        } catch (error) {
          parentPort.postMessage({ ok: false, code: error.code });
        } finally { auth.close(); }
      });
    }).catch((error) => { throw error; });
  `;
  const worker = new Worker(source, { eval: true, workerData: { authURL: AUTH_URL, stateDirectory, pairing, time: TIME } });
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => { if (message.ready) resolve(); });
  });
  const outcome = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => { if ('ok' in message) resolve(message); });
  });
  return { worker, ready, outcome };
}

test('two simultaneous independent SQLite connections redeem one pairing exactly once', { timeout: 10_000 }, async (t) => {
  const f = fixture(t); const auth = f.open(); const pairing = auth.createPairing();
  const peers = [competingWorker(f.stateDirectory, pairing), competingWorker(f.stateDirectory, pairing)];
  try {
    await Promise.all(peers.map(({ ready }) => ready));
    for (const { worker } of peers) worker.postMessage('redeem');
    const outcomes = await Promise.all(peers.map(({ outcome }) => outcome));
    assert.equal(outcomes.filter(({ ok }) => ok).length, 1);
    assert.deepEqual(outcomes.filter(({ ok }) => !ok).map(({ code }) => code), ['invalid_code']);
    assert.ok(auth.authenticate(outcomes.find(({ ok }) => ok).token));
    assert.equal(auth.listDevices().length, 1);
  } finally { await Promise.all(peers.map(({ worker }) => worker.terminate())); }
});
