import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AuthDatabase } from '../src/auth/auth-database.mjs';
import { RequestOwnershipStore } from '../src/relay/request-ownership-store.mjs';

export function ownershipFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abot-request-ownership-')));
  const stateDirectory = join(root, 'state');
  const connections = [];
  let time = 1_000_000;
  const now = () => time;
  const open = () => {
    const database = new AuthDatabase(stateDirectory);
    connections.push(database);
    return { database, store: new RequestOwnershipStore({ database, now }) };
  };
  t.after(() => {
    for (const database of connections) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const current = open();
  const subject = current.database.ownerId;
  const identity = (extra = {}) => ({ subject, deviceId: 'device',
    runtimeId: 'runtime', sessionId: 'session', requestId: 'request', ...extra });
  return { ...current, stateDirectory, identity, open, now, advance: amount => { time += amount; } };
}

/** Populate valid routing rows without hundreds of unrelated filesystem commits. */
export function seedOwnership(fixture, count) {
  fixture.database.transaction(() => {
    const insert = fixture.database.prepare(`INSERT INTO request_ownership
      (runtime_id, session_id, request_id, subject, device_id, status, created_at)
      VALUES ('runtime', 'session', ?, ?, 'device', 'open', ?)`);
    for (let index = 0; index < count; index++)
      insert.run(`seed-${index}`, fixture.database.ownerId, fixture.now());
  });
}

export function competingOwnershipWorker(stateDirectory, identity, time) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.databaseURL), import(workerData.storeURL)]).then(([a, s]) => {
      const database = new a.AuthDatabase(workerData.stateDirectory);
      const store = new s.RequestOwnershipStore({ database, now: () => workerData.time });
      parentPort.postMessage({ ready: true });
      parentPort.once('message', () => {
        try { store.create(workerData.identity); parentPort.postMessage({ ok: true }); }
        catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
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
  return { worker, ready, outcome };
}
