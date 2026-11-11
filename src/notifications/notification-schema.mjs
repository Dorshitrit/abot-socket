/** Metadata only: conversation content and authentication credentials never enter this ledger. */
export const NOTIFICATION_SCHEMA = `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    runtime_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('completed', 'failed', 'approval_required')),
    approval_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    read_at INTEGER, expires_at INTEGER NOT NULL,
    UNIQUE(device_id, runtime_id, request_id, kind, approval_id)
  ) STRICT;
  CREATE INDEX notifications_device_time ON notifications(device_id, created_at DESC, id DESC);
  CREATE INDEX notifications_expiry ON notifications(expires_at);
  CREATE TABLE notification_registrations (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('fcm', 'gateway')),
    registration TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE notification_outbox (
    notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
  ) STRICT;
`;
