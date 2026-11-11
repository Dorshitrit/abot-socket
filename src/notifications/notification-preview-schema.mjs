export const NOTIFICATION_PREVIEW_SCHEMA = `
  CREATE TABLE notification_preview_keys (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL, key_bytes BLOB NOT NULL CHECK(length(key_bytes) = 32)
  ) STRICT;
  ALTER TABLE notification_outbox ADD COLUMN encrypted_preview TEXT;
`;
