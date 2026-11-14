import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertSameDatabaseFile, prepareAuthenticationDatabase } from './auth-storage-path.mjs';
import { NOTIFICATION_SCHEMA } from '../notifications/notification-schema.mjs';
import { NOTIFICATION_PREVIEW_SCHEMA } from '../notifications/notification-preview-schema.mjs';
import { REQUEST_OWNERSHIP_SCHEMA } from '../relay/request-ownership-schema.mjs';

const APPLICATION_ID = 0x41425341;
const SCHEMA_VERSION = 4;

const SCHEMA = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE pairing (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE, digest BLOB NOT NULL, salt BLOB NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 5)
  ) STRICT;
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, device_name TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE INDEX devices_expiry ON devices(expires_at);
  CREATE TABLE pairing_attempts (source TEXT NOT NULL, attempted_at INTEGER NOT NULL) STRICT;
  CREATE INDEX attempts_time ON pairing_attempts(attempted_at);
  CREATE INDEX attempts_source ON pairing_attempts(source, attempted_at);
`;

/** One durable store shared by the operator CLI and relay processes. */
export class AuthDatabase {
  #connection;
  #closed = false;

  constructor(stateDirectory) {
    const prepared = prepareAuthenticationDatabase(stateDirectory);
    this.#connection = new DatabaseSync(prepared.path);
    try {
      assertSameDatabaseFile(stateDirectory, prepared);
      this.#connection.exec('PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;');
      const mode = this.#connection.prepare('PRAGMA journal_mode').get().journal_mode;
      if (mode !== 'delete') throw new Error('Authentication database must use DELETE journaling');
      this.transaction(() => this.#initialize());
      this.#connection.exec('PRAGMA synchronous = FULL;');
      assertSameDatabaseFile(stateDirectory, prepared);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  prepare(sql) {
    return this.#connection.prepare(sql);
  }

  transaction(operation) {
    this.#connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.#connection.exec('ROLLBACK');
      throw error;
    }
  }

  get ownerId() {
    return this.prepare("SELECT value FROM metadata WHERE key = 'owner_id'").get().value;
  }

  get tokenSalt() {
    return this.prepare("SELECT value FROM metadata WHERE key = 'token_salt'").get().value;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
  }

  #initialize() {
    const applicationId = this.prepare('PRAGMA application_id').get().application_id;
    const version = this.prepare('PRAGMA user_version').get().user_version;
    if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) return;
    if (applicationId === APPLICATION_ID && [1, 2, 3].includes(version)) {
      if (version === 1) this.#connection.exec(NOTIFICATION_SCHEMA);
      if (version <= 2) this.#connection.exec(NOTIFICATION_PREVIEW_SCHEMA);
      this.#connection.exec(REQUEST_OWNERSHIP_SCHEMA);
      this.#connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      return;
    }
    const objects = this.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (applicationId !== 0 || version !== 0 || objects.length) {
      throw new Error('Unrecognized authentication database; no changes were made');
    }
    this.#connection.exec(SCHEMA);
    this.#connection.exec(NOTIFICATION_SCHEMA);
    this.#connection.exec(NOTIFICATION_PREVIEW_SCHEMA);
    this.#connection.exec(REQUEST_OWNERSHIP_SCHEMA);
    const insert = this.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
    insert.run('owner_id', randomUUID());
    insert.run('token_salt', randomBytes(32).toString('hex'));
    this.#connection.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
}
