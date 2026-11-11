import { validatedNotificationPreview } from './notification-preview-crypto.mjs';

const MAX_ATTEMPTS = 5;
const CLAIM_MS = 30_000;

/** Durable bounded retries for already-recorded events; never executes a runtime request. */
export class NotificationOutbox {
  constructor({ database, now = Date.now }) { this.database = database; this.now = now; }

  claim(provider) {
    return this.database.transaction(() => {
      this.database.prepare('DELETE FROM notification_outbox WHERE attempts >= ?').run(MAX_ATTEMPTS);
      const row = this.database.prepare(`SELECT n.id, n.device_id AS deviceId, n.runtime_id AS runtimeId,
        n.session_id AS sessionId, n.request_id AS requestId, n.kind, n.created_at AS createdAt,
        n.read_at AS readAt, n.expires_at AS expiresAt, o.attempts, o.encrypted_preview, r.registration
        FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id
        JOIN devices d ON d.id = n.device_id JOIN notification_registrations r ON r.device_id = n.device_id
        WHERE o.next_at <= ? AND n.read_at IS NULL AND n.expires_at > ? AND d.expires_at > ?
        AND r.provider = ? ORDER BY o.next_at, n.created_at, n.id LIMIT 1`)
        .get(this.now(), this.now(), this.now(), provider);
      if (!row) return null;
      this.database.prepare('UPDATE notification_outbox SET attempts = attempts + 1, next_at = ? WHERE notification_id = ?')
        .run(this.now() + CLAIM_MS, row.id);
      const { deviceId, registration, attempts, encrypted_preview: encodedPreview, ...notification } = row;
      if (encodedPreview) {
        try {
          const preview = validatedNotificationPreview(JSON.parse(encodedPreview), notification, this.now());
          if (preview) notification.preview = preview;
        } catch { /* Corrupt previews fall back to the generic notification. */ }
      }
      return { deviceId, registration: JSON.parse(registration), attempts: attempts + 1, notification, encodedPreview };
    });
  }

  canDeliver(entry) {
    const row = this.database.prepare(`SELECT r.registration, o.encrypted_preview FROM notification_outbox o
      JOIN notifications n ON n.id = o.notification_id JOIN devices d ON d.id = n.device_id
      JOIN notification_registrations r ON r.device_id = n.device_id
      WHERE n.id = ? AND n.device_id = ? AND n.read_at IS NULL AND n.expires_at > ? AND d.expires_at > ?`)
      .get(entry.notification.id, entry.deviceId, this.now(), this.now());
    return row?.registration === JSON.stringify(entry.registration) && row.encrypted_preview === entry.encodedPreview;
  }

  cancel(entry) {
    // A cancelled send spends no attempt and cannot recreate a read/revoked item.
    this.database.prepare(`UPDATE notification_outbox SET attempts = MAX(0, attempts - 1), next_at = ?
      WHERE notification_id = ? AND attempts = ?`)
      .run(this.now() + CLAIM_MS, entry.notification.id, entry.attempts);
  }

  finish(entry, status) {
    if (['delivered', 'invalid', 'discarded'].includes(status) || entry.attempts >= MAX_ATTEMPTS) {
      this.database.prepare('DELETE FROM notification_outbox WHERE notification_id = ?').run(entry.notification.id);
      return;
    }
    const backoff = Math.min(600_000, 30_000 * 2 ** (entry.attempts - 1));
    this.database.prepare('UPDATE notification_outbox SET next_at = ? WHERE notification_id = ?')
      .run(this.now() + backoff, entry.notification.id);
  }
}
