import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertSameDatabaseFile, prepareAuthenticationDatabase } from '../auth/auth-storage-path.mjs';

const APPLICATION_ID = 0x41424757;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

function matchesCredential(value, expected) {
  if (typeof value !== 'string' || !SECRET.test(value) || !expected) return false;
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex'));
}

/** Isolated gateway state. Never point this at a Socket authentication directory. */
export class NotificationGatewayStore {
  constructor({ stateDirectory, now = Date.now }) {
    this.now = now;
    const prepared = prepareAuthenticationDatabase(stateDirectory);
    this.db = new DatabaseSync(prepared.path);
    try {
      assertSameDatabaseFile(stateDirectory, prepared);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON;');
      if (this.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw new Error();
      this.transaction(() => this.initialize());
      this.db.exec('PRAGMA synchronous=FULL;');
      assertSameDatabaseFile(stateDirectory, prepared);
    } catch {
      this.db.close();
      throw new Error('Gateway requires its own private state directory with a recognized database');
    }
  }

  initialize() {
    const id = this.db.prepare('PRAGMA application_id').get().application_id;
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (id === APPLICATION_ID && version === 1) return;
    const objects = this.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (id || version || objects.length) throw new Error();
    this.db.exec(`
      CREATE TABLE gateway_challenges (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, token_hash TEXT NOT NULL,
        proof_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE gateway_token_attempts (token_hash TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL) STRICT;
      CREATE TABLE gateway_endpoints (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        send_hash TEXT NOT NULL, manage_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE gateway_deliveries (
        endpoint_id TEXT NOT NULL REFERENCES gateway_endpoints(id) ON DELETE CASCADE,
        notification_id TEXT NOT NULL, done INTEGER NOT NULL, lease_until INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, PRIMARY KEY(endpoint_id, notification_id)
      ) STRICT;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
    `);
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  prune() {
    const now = this.now();
    this.db.prepare('DELETE FROM gateway_challenges WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM gateway_token_attempts WHERE attempted_at<=?').run(now - 120_000);
    this.db.prepare('DELETE FROM gateway_endpoints WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM gateway_deliveries WHERE expires_at<=?').run(now);
  }

  createChallenge(token) {
    return this.transaction(() => {
      this.prune();
      const tokenHash = digest(token);
      if (this.db.prepare('SELECT 1 FROM gateway_token_attempts WHERE token_hash=?').get(tokenHash)) {
        throw failure('rate_limited', 429);
      }
      const count = this.db.prepare('SELECT count(*) AS total FROM gateway_challenges').get().total;
      if (count >= 128) throw failure('capacity', 503);
      const challengeId = secret(); const proof = secret(); const expiresAt = this.now() + 120_000;
      this.db.prepare('INSERT INTO gateway_token_attempts VALUES (?, ?)').run(tokenHash, this.now());
      this.db.prepare('INSERT INTO gateway_challenges VALUES (?, ?, ?, ?, ?, 0)')
        .run(challengeId, token, tokenHash, digest(proof), expiresAt);
      return { challengeId, proof, expiresAt };
    });
  }

  removeChallenge(id) { this.db.prepare('DELETE FROM gateway_challenges WHERE id=?').run(id); }

  confirm(challengeId, proof) {
    return this.transaction(() => {
      this.prune();
      const challenge = this.db.prepare('SELECT * FROM gateway_challenges WHERE id=?').get(challengeId);
      if (!challenge) return null;
      if (!matchesCredential(proof, challenge.proof_hash)) {
        if (challenge.attempts >= 4) this.removeChallenge(challengeId);
        else this.db.prepare('UPDATE gateway_challenges SET attempts=attempts+1 WHERE id=?').run(challengeId);
        return null;
      }
      const existing = this.db.prepare('SELECT id FROM gateway_endpoints WHERE token_hash=?').get(challenge.token_hash);
      const count = this.db.prepare('SELECT count(*) AS total FROM gateway_endpoints').get().total;
      if (!existing && count >= 1024) throw failure('capacity', 503);
      const endpointId = secret(); const sendToken = secret(); const manageToken = secret();
      const expiresAt = this.now() + 30 * 86_400_000;
      // Only a successfully proven replacement rotates an existing target grant.
      if (existing) this.db.prepare('DELETE FROM gateway_endpoints WHERE id=?').run(existing.id);
      this.db.prepare('INSERT INTO gateway_endpoints VALUES (?, ?, ?, ?, ?, ?)')
        .run(endpointId, challenge.token, challenge.token_hash, digest(sendToken), digest(manageToken), expiresAt);
      this.removeChallenge(challengeId);
      return { endpointId, sendToken, manageToken, expiresAt };
    });
  }

  authorize(endpointId, credential, management = false) {
    const endpoint = this.db.prepare('SELECT * FROM gateway_endpoints WHERE id=? AND expires_at>?')
      .get(endpointId, this.now());
    if (!endpoint || !matchesCredential(credential, management ? endpoint.manage_hash : endpoint.send_hash)) return null;
    return { id: endpoint.id, token: endpoint.token, expiresAt: endpoint.expires_at };
  }

  revoke(endpointId, manageToken) {
    if (!this.authorize(endpointId, manageToken, true)) return false;
    this.db.prepare('DELETE FROM gateway_endpoints WHERE id=?').run(endpointId);
    return true;
  }

  removeInvalidEndpoint(endpointId) { this.db.prepare('DELETE FROM gateway_endpoints WHERE id=?').run(endpointId); }

  claimDelivery(endpointId, notificationId, expiresAt) {
    return this.transaction(() => {
      this.prune();
      const prior = this.db.prepare('SELECT * FROM gateway_deliveries WHERE endpoint_id=? AND notification_id=?')
        .get(endpointId, notificationId);
      if (prior?.done) return 'done';
      if (prior?.lease_until > this.now()) return 'busy';
      const count = this.db.prepare('SELECT count(*) AS total FROM gateway_deliveries').get().total;
      if (!prior && count >= 20_000) throw failure('capacity', 503);
      this.db.prepare(`INSERT INTO gateway_deliveries VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(endpoint_id,notification_id) DO UPDATE SET lease_until=excluded.lease_until`)
        .run(endpointId, notificationId, this.now() + 15_000, expiresAt);
      return 'send';
    });
  }

  finishDelivery(endpointId, notificationId, delivered) {
    if (delivered) {
      this.db.prepare('UPDATE gateway_deliveries SET done=1,lease_until=0 WHERE endpoint_id=? AND notification_id=?')
        .run(endpointId, notificationId);
      return;
    }
    this.db.prepare('DELETE FROM gateway_deliveries WHERE endpoint_id=? AND notification_id=? AND done=0')
      .run(endpointId, notificationId);
  }

  close() { this.db.close(); }
}
