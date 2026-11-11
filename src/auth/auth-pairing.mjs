import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { AuthError, sourceKey } from './auth-limits.mjs';
import { issueDeviceSession } from './auth-sessions.mjs';

const PAIRING_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const codeDigest = (code, salt) => scryptSync(code, salt, 32);
const invalidCode = () => ({ error: new AuthError('invalid_code', 401) });

function hasPairingInput(input) {
  if (!input || typeof input !== 'object') return false;
  return !Array.isArray(input);
}

function hasValidDeviceName(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (name.length > 80) return false;
  return !/[\x00-\x1f\x7f]/.test(name);
}

function matchesPairingCode(code, pairing) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  return timingSafeEqual(pairing.digest, codeDigest(code, pairing.salt));
}

export class AuthPairingStore {
  constructor({ database, now }) {
    this.database = database;
    this.now = now;
  }

  create() {
    const pairingId = randomBytes(24).toString('base64url');
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(32);
    const digest = codeDigest(code, salt);
    const expiresAt = this.now() + PAIRING_MS;
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM pairing').run();
      this.database.prepare(`INSERT INTO pairing(singleton, id, digest, salt, expires_at, attempts)
        VALUES (1, ?, ?, ?, ?, 0)`).run(pairingId, digest, salt, expiresAt);
    });
    return { pairingId, code, expiresAt };
  }

  redeem(input, sourceId) {
    const source = sourceKey(sourceId);
    const result = this.database.transaction(() => this.#redeemTransaction(input, source));
    if (result.error) throw result.error;
    return result;
  }

  prune() {
    const time = this.now();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM pairing WHERE expires_at <= ?').run(time);
      this.database.prepare('DELETE FROM pairing_attempts WHERE attempted_at <= ?').run(time - RATE_WINDOW_MS);
    });
  }

  #redeemTransaction(input, source) {
    const time = this.now();
    if (!hasPairingInput(input)) return invalidCode();
    const { deviceName = 'Device' } = input;
    if (!hasValidDeviceName(deviceName)) return { error: new AuthError('invalid_request', 400) };
    if (typeof input.pairingId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.pairingId)) return invalidCode();
    const pairing = this.database.prepare('SELECT * FROM pairing WHERE id = ? AND expires_at > ?')
      .get(input.pairingId, time);
    if (!pairing || pairing.attempts >= MAX_ATTEMPTS) return invalidCode();
    // Unrelated or unusable challenges must not spend the verification quota.
    if (!this.#consumeRateLimit(source, time)) return { error: new AuthError('rate_limited', 429) };
    if (!matchesPairingCode(input.code, pairing)) {
      this.database.prepare('UPDATE pairing SET attempts = attempts + 1 WHERE id = ?').run(pairing.id);
      return invalidCode();
    }
    let session;
    try { session = issueDeviceSession(this.database, time, deviceName.trim()); } catch (error) {
      if (error instanceof AuthError) return { error };
      throw error;
    }
    this.database.prepare('DELETE FROM pairing WHERE id = ?').run(pairing.id);
    return session;
  }

  #consumeRateLimit(source, time) {
    this.database.prepare('DELETE FROM pairing_attempts WHERE attempted_at <= ?').run(time - RATE_WINDOW_MS);
    const total = this.database.prepare('SELECT count(*) AS count FROM pairing_attempts').get().count;
    if (total >= 100) return false;
    const attempts = this.database.prepare('SELECT count(*) AS count FROM pairing_attempts WHERE source = ?').get(source).count;
    if (attempts >= 20) return false;
    this.database.prepare('INSERT INTO pairing_attempts(source, attempted_at) VALUES (?, ?)').run(source, time);
    return true;
  }
}
