import { AuthDatabase } from './auth-database.mjs';
import { AuthPairingStore } from './auth-pairing.mjs';
import { AuthSessionStore } from './auth-sessions.mjs';

export { AuthError } from './auth-limits.mjs';

/** Single-owner local pairing; only redemption is exposed by the HTTP API. */
export class AuthService {
  #database;
  #pairing;
  #sessions;
  #ownsDatabase;

  constructor({ stateDirectory, database, now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('An authentication clock is required');
    this.#ownsDatabase = database === undefined;
    this.#database = database ?? new AuthDatabase(stateDirectory);
    try {
      this.#pairing = new AuthPairingStore({ database: this.#database, now });
      this.#sessions = new AuthSessionStore({ database: this.#database, now });
    } catch (error) {
      if (this.#ownsDatabase) this.#database.close();
      throw error;
    }
  }

  createPairing() { return this.#pairing.create(); }
  redeemPairing(input, sourceId) { return this.#pairing.redeem(input, sourceId); }
  authenticate(token) { return this.#sessions.authenticate(token); }
  listSessions(principal) { return this.#sessions.list(principal); }
  revoke(principal, sessionId) { return this.#sessions.revoke(principal, sessionId); }
  listDevices() { return this.#sessions.listDevices(); }
  revokeDevice(sessionId) { return this.#sessions.revokeDevice(sessionId); }
  subscribeRevocations(listener) { return this.#sessions.subscribeRevocations(listener); }

  prune() {
    this.#pairing.prune();
    this.#sessions.prune();
  }

  close() {
    this.#sessions.close();
    if (this.#ownsDatabase) this.#database.close();
  }
}
