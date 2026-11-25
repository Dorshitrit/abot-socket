/** v5 preserves existing session notifications, delivery attempts, previews and all pairing state. */
export const AGENT_NOTIFICATION_SCHEMA = `
  CREATE TEMP TABLE agent_notification_rows_copy AS SELECT * FROM notifications;
  CREATE TEMP TABLE agent_notification_outbox_copy AS SELECT * FROM notification_outbox;
  DROP TABLE notification_outbox;
  DROP TABLE notifications;
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    runtime_id TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'session' CHECK(target IN ('session', 'agent')),
    session_id TEXT, request_id TEXT, agent_id TEXT, mission_id TEXT, message_id TEXT,
    source_event_id TEXT, reason TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('completed', 'failed', 'approval_required')),
    approval_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    read_at INTEGER, expires_at INTEGER NOT NULL,
    CHECK ((target = 'session' AND session_id IS NOT NULL AND request_id IS NOT NULL
      AND agent_id IS NULL AND source_event_id IS NULL AND reason IS NULL)
      OR (target = 'agent' AND session_id IS NULL AND request_id IS NULL AND agent_id IS NOT NULL
      AND mission_id IS NOT NULL AND source_event_id IS NOT NULL AND reason IS NOT NULL)),
    UNIQUE(device_id, runtime_id, request_id, kind, approval_id),
    UNIQUE(device_id, runtime_id, source_event_id)
  ) STRICT;
  INSERT INTO notifications(id, device_id, runtime_id, session_id, request_id, kind,
    approval_id, created_at, read_at, expires_at)
    SELECT id, device_id, runtime_id, session_id, request_id, kind,
      approval_id, created_at, read_at, expires_at FROM agent_notification_rows_copy;
  CREATE INDEX notifications_device_time ON notifications(device_id, created_at DESC, id DESC);
  CREATE INDEX notifications_expiry ON notifications(expires_at);
  CREATE TABLE notification_outbox (
    notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, encrypted_preview TEXT
  ) STRICT;
  INSERT INTO notification_outbox SELECT notification_id, attempts, next_at, encrypted_preview
    FROM agent_notification_outbox_copy;
  DROP TABLE agent_notification_rows_copy;
  DROP TABLE agent_notification_outbox_copy;
  CREATE TABLE notification_client_capabilities (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    agents_enabled_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE agent_notification_receipts (
    runtime_id TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    expires_at INTEGER NOT NULL, PRIMARY KEY(runtime_id, event_id)
  ) STRICT;
  CREATE INDEX agent_notification_receipts_expiry ON agent_notification_receipts(expires_at);
`;
