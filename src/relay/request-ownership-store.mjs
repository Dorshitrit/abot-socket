import { isRelayId, relayError } from './relay-runtime-registration.mjs';

const MAX_OWNERSHIP_RECORDS = 512;
const TERMINAL_RETENTION_MS = 12 * 60 * 60 * 1000;
const SELECT_RECORD = `SELECT runtime_id AS runtimeId, session_id AS sessionId,
  request_id AS requestId, subject, device_id AS deviceId, status,
  created_at AS createdAt, terminal_at AS terminalAt FROM request_ownership`;

function assertRequestIdentity(runtimeId, requestId) {
  if (!isRelayId(runtimeId)) throw relayError('invalid_request_identity');
  if (!isRelayId(requestId)) throw relayError('invalid_request_identity');
}

function assertOwnershipIdentity(identity, ownerId) {
  if (!identity || typeof identity !== 'object') throw relayError('invalid_request_identity');
  assertRequestIdentity(identity.runtimeId, identity.requestId);
  if (!isRelayId(identity.sessionId)) throw relayError('invalid_request_identity');
  if (identity.subject !== ownerId) throw relayError('invalid_request_identity');
  if (typeof identity.deviceId !== 'string') throw relayError('invalid_request_identity');
  if (!identity.deviceId.trim() || identity.deviceId.length > 256) throw relayError('invalid_request_identity');
}

/** Durable owner binding, never an approval cache or a queue for replaying runs. */
export class RequestOwnershipStore {
  constructor({ database, now = Date.now }) {
    if (typeof database?.prepare !== 'function' || typeof database?.transaction !== 'function') {
      throw new TypeError('An authentication database is required');
    }
    if (typeof now !== 'function') throw new TypeError('An ownership clock is required');
    this.database = database;
    this.now = now;
  }

  create(identity) {
    assertOwnershipIdentity(identity, this.database.ownerId);
    const time = this.#time();
    return this.database.transaction(() => {
      if (this.get(identity.runtimeId, identity.requestId)) throw relayError('request_id_conflict');
      return this.#insert(identity, time, false);
    });
  }

  isOwnerSubject(subject) {
    return subject === this.database.ownerId;
  }

  /** The relay must first verify the exact canonical request on the authorized runtime. */
  adopt(identity, terminal = false) {
    assertOwnershipIdentity(identity, this.database.ownerId);
    if (typeof terminal !== 'boolean') throw relayError('invalid_request_identity');
    const time = this.#time();
    return this.database.transaction(() => {
      const existing = this.get(identity.runtimeId, identity.requestId);
      if (!existing) return this.#insert(identity, time, terminal);
      if (existing.subject !== identity.subject) throw relayError('request_not_owned');
      if (existing.sessionId !== identity.sessionId) throw relayError('request_not_owned');
      return existing;
    });
  }

  get(runtimeId, requestId) {
    assertRequestIdentity(runtimeId, requestId);
    const record = this.database.prepare(`${SELECT_RECORD} WHERE runtime_id = ? AND request_id = ?`)
      .get(runtimeId, requestId);
    return record ? { ...record } : null;
  }

  listSession(runtimeId, sessionId) {
    if (!isRelayId(runtimeId) || !isRelayId(sessionId)) throw relayError('invalid_request_identity');
    return this.database.prepare(`${SELECT_RECORD} WHERE runtime_id = ? AND session_id = ?
      ORDER BY created_at, request_id LIMIT ?`)
      .all(runtimeId, sessionId, MAX_OWNERSHIP_RECORDS).map(record => ({ ...record }));
  }

  markTerminal(runtimeId, requestId) {
    assertRequestIdentity(runtimeId, requestId);
    return this.database.prepare(`UPDATE request_ownership SET status = 'terminal', terminal_at = ?
      WHERE runtime_id = ? AND request_id = ? AND status = 'open'`)
      .run(this.#time(), runtimeId, requestId).changes > 0;
  }

  /** The caller must have confirmed deletion of the complete canonical session. */
  retireSession(runtimeId, sessionId) {
    if (!isRelayId(runtimeId) || !isRelayId(sessionId)) throw relayError('invalid_request_identity');
    return this.database.prepare('DELETE FROM request_ownership WHERE runtime_id = ? AND session_id = ?')
      .run(runtimeId, sessionId).changes;
  }

  prune() {
    return this.#deleteExpired(this.#time());
  }

  #insert(identity, time, terminal) {
    this.#deleteExpired(time);
    const count = this.database.prepare('SELECT count(*) AS count FROM request_ownership').get().count;
    if (count >= MAX_OWNERSHIP_RECORDS) throw relayError('request_capacity');
    this.database.prepare(`INSERT INTO request_ownership
      (runtime_id, request_id, session_id, subject, device_id, status, created_at, terminal_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(identity.runtimeId, identity.requestId, identity.sessionId, identity.subject, identity.deviceId,
        terminal ? 'terminal' : 'open', time, terminal ? time : null);
    return this.get(identity.runtimeId, identity.requestId);
  }

  #deleteExpired(time) {
    return this.database.prepare("DELETE FROM request_ownership WHERE status = 'terminal' AND terminal_at <= ?")
      .run(time - TERMINAL_RETENTION_MS).changes;
  }

  #time() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('Invalid ownership clock');
    return time;
  }
}
