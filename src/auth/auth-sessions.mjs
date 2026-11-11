import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthError } from './auth-limits.mjs';

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;
const tokenHash = (database, token) => createHash('sha256').update(database.tokenSalt).update(token).digest('hex');

/** Called only inside the pairing transaction, before consuming its challenge. */
export function issueDeviceSession(database, time, deviceName) {
  database.prepare('DELETE FROM devices WHERE expires_at <= ?').run(time);
  const count = database.prepare('SELECT count(*) AS count FROM devices WHERE expires_at > ?').get(time).count;
  if (count >= MAX_SESSIONS) throw new AuthError('device_limit', 429);
  const token = randomBytes(32).toString('base64url');
  const session = { id: randomUUID(), subject: database.ownerId, deviceName };
  const expiresAt = time + SESSION_MS;
  database.prepare(`INSERT INTO devices(id, subject, device_name, created_at, expires_at, token_hash)
    VALUES (?, ?, ?, ?, ?, ?)`).run(session.id, session.subject, deviceName, time, expiresAt, tokenHash(database, token));
  return { token, expiresAt, session };
}

function assertDeviceId(id) {
  if (typeof id !== 'string' || !id || id.length > 64) throw new AuthError('invalid_request', 400);
}

export class AuthSessionStore {
  #database;
  #principals = new WeakSet();
  #listeners = new Set();
  #observed = new Set();

  constructor({ database, now }) {
    this.#database = database;
    this.now = now;
    this.#observed = new Set(database.prepare('SELECT id FROM devices').all().map(({ id }) => id));
  }

  authenticate(token) {
    this.prune();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const record = this.#database.prepare('SELECT id, subject, expires_at FROM devices WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash(this.#database, token), this.now());
    if (!record) return null;
    const principal = Object.freeze({ sessionId: record.id, subject: record.subject, expiresAt: record.expires_at });
    this.#principals.add(principal);
    return principal;
  }

  list(principal) {
    this.prune();
    return this.#database.transaction(() => {
      this.#assertPrincipal(principal);
      return this.#records().map((record) => ({ ...record, current: record.id === principal.sessionId }));
    });
  }

  listDevices() {
    this.prune();
    return this.#records();
  }

  revoke(principal, id) {
    this.prune();
    assertDeviceId(id);
    const changed = this.#database.transaction(() => {
      this.#assertPrincipal(principal);
      return this.#database.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
    });
    if (changed) this.#notifyRemoval(id);
    return changed;
  }

  revokeDevice(id) {
    assertDeviceId(id);
    const changed = this.#database.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
    if (changed) this.#notifyRemoval(id);
    return changed;
  }

  subscribeRevocations(listener) {
    if (typeof listener !== 'function') throw new TypeError('A revocation listener is required');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  prune() {
    const active = this.#database.transaction(() => {
      this.#database.prepare('DELETE FROM devices WHERE expires_at <= ?').run(this.now());
      return new Set(this.#database.prepare('SELECT id FROM devices').all().map(({ id }) => id));
    });
    const removed = [...this.#observed].filter((id) => !active.has(id));
    this.#observed = active;
    for (const id of removed) this.#notifyRemoval(id);
  }

  close() {
    this.#listeners.clear();
    this.#observed.clear();
  }

  #records() {
    return this.#database.prepare(`SELECT id, device_name AS deviceName, created_at AS createdAt,
      expires_at AS expiresAt FROM devices WHERE expires_at > ? ORDER BY created_at, id`).all(this.now())
      .map((record) => ({ ...record }));
  }

  #assertPrincipal(principal) {
    if (!principal || !this.#principals.has(principal)) throw new AuthError('unauthorized', 401);
    const record = this.#database.prepare('SELECT subject FROM devices WHERE id = ? AND expires_at > ?')
      .get(principal.sessionId, this.now());
    if (!record || record.subject !== principal.subject) throw new AuthError('unauthorized', 401);
  }

  #notifyRemoval(id) {
    this.#observed.delete(id);
    for (const listener of this.#listeners) {
      try { listener(id); } catch { /* A listener cannot restore a revoked device. */ }
    }
  }
}
