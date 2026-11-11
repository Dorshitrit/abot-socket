import { notificationPreviewText } from './notification-preview-text.mjs';
import { sealNotificationPreview } from './notification-preview-crypto.mjs';

/** Keys stay device-scoped; only ciphertext enters the delivery queue. */
export class NotificationPreviewStore {
  constructor({ database, now = Date.now }) { this.database = database; this.now = now; }

  status(deviceId) {
    const row = this.database.prepare(`SELECT p.key_id FROM notification_preview_keys p
      JOIN devices d ON d.id = p.device_id JOIN notification_registrations r ON r.device_id = p.device_id
      WHERE p.device_id = ? AND d.expires_at > ?`).get(deviceId, this.now());
    return { supported: true, enabled: Boolean(row), keyId: row?.key_id ?? null };
  }

  enable(deviceId, value) {
    return this.database.transaction(() => {
      const registered = this.database.prepare(`SELECT d.id FROM devices d
        JOIN notification_registrations r ON r.device_id = d.id WHERE d.id = ? AND d.expires_at > ?`)
        .get(deviceId, this.now());
      if (!registered) return false;
      this.database.prepare(`INSERT INTO notification_preview_keys(device_id, key_id, key_bytes) VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET key_id = excluded.key_id, key_bytes = excluded.key_bytes`)
        .run(deviceId, value.keyId, Buffer.from(value.key, 'base64url'));
      this.clearQueued(deviceId);
      return true;
    });
  }

  clearQueued(deviceId) {
    this.database.prepare(`UPDATE notification_outbox SET encrypted_preview = NULL WHERE notification_id IN
      (SELECT id FROM notifications WHERE device_id = ?)`).run(deviceId);
  }

  removeKey(deviceId) {
    this.database.prepare('DELETE FROM notification_preview_keys WHERE device_id = ?').run(deviceId);
    this.clearQueued(deviceId);
  }

  disable(deviceId) { this.database.transaction(() => this.removeKey(deviceId)); }

  attach(item, output) {
    if (item.kind !== 'completed') return;
    try {
      const key = this.database.prepare(`SELECT p.key_id, p.key_bytes FROM notification_preview_keys p
        JOIN devices d ON d.id = p.device_id JOIN notification_registrations r ON r.device_id = p.device_id
        WHERE p.device_id = ? AND d.expires_at > ?`).get(item.deviceId, this.now());
      if (!key) return;
      const text = notificationPreviewText(output);
      if (!text) return;
      const preview = sealNotificationPreview(key.key_id, Buffer.from(key.key_bytes), item, text);
      this.database.prepare(`UPDATE notification_outbox SET encrypted_preview = ? WHERE notification_id = ?
        AND EXISTS (SELECT 1 FROM notification_preview_keys WHERE device_id = ? AND key_id = ? AND key_bytes = ?)`)
        .run(JSON.stringify(preview), item.id, item.deviceId, key.key_id, key.key_bytes);
    } catch { /* The already-durable generic notification remains deliverable. */ }
  }

  prune() {
    this.database.prepare(`DELETE FROM notification_preview_keys WHERE NOT EXISTS
      (SELECT 1 FROM devices WHERE id = device_id AND expires_at > ?) OR NOT EXISTS
      (SELECT 1 FROM notification_registrations r WHERE r.device_id = notification_preview_keys.device_id)`)
      .run(this.now());
  }
}
