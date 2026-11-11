import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WindowLimiter } from '../transport/transport-limits.mjs';

const CSRF_MS = 10 * 60 * 1000;

function matchesReviewerAuthorization(value, username, passwordSha256) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) return false;
  const decoded = bytes.toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== username) return false;
  const password = decoded.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) return false;
  const digest = createHash('sha256').update(password).digest();
  return timingSafeEqual(digest, Buffer.from(passwordSha256, 'hex'));
}

/** Browser access grants pairing issuance only, never a runtime or device token. */
export class ReviewPortalAccess {
  constructor({ username, passwordSha256, now = Date.now }) {
    if (username !== 'reviewer' || !/^[a-f0-9]{64}$/.test(passwordSha256 ?? '')) {
      throw new Error('Invalid reviewer access configuration');
    }
    this.username = username;
    this.passwordSha256 = passwordSha256;
    this.now = now;
    this.csrfKey = randomBytes(32);
    this.failedSources = new WindowLimiter({ limit: 10, windowMs: 900_000, now });
    this.failedTotal = new WindowLimiter({ limit: 200, windowMs: 900_000, capacity: 1, now });
    this.pairSources = new WindowLimiter({ limit: 5, windowMs: 60_000, now });
    this.pairTotal = new WindowLimiter({ limit: 20, windowMs: 60_000, capacity: 1, now });
  }

  authenticate(authorization, sourceId) {
    if (matchesReviewerAuthorization(authorization, this.username, this.passwordSha256)) return 200;
    if (!this.failedSources.allow(sourceId)) return 429;
    if (!this.failedTotal.allow('failures')) return 429;
    return 401;
  }

  createCsrf() {
    const value = `${this.now()}.${randomBytes(16).toString('base64url')}`;
    return `${value}.${createHmac('sha256', this.csrfKey).update(value).digest('base64url')}`;
  }

  acceptsCsrf(token) {
    if (typeof token !== 'string' || token.length > 128) return false;
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return false;
    const issuedAt = Number(match[1]);
    if (!Number.isSafeInteger(issuedAt) || issuedAt > this.now()) return false;
    if (this.now() - issuedAt >= CSRF_MS) return false;
    const expected = createHmac('sha256', this.csrfKey).update(`${match[1]}.${match[2]}`).digest('base64url');
    return timingSafeEqual(Buffer.from(match[3]), Buffer.from(expected));
  }

  allowPairing(sourceId) {
    if (!this.pairSources.allow(sourceId)) return false;
    return this.pairTotal.allow('pairings');
  }
}
