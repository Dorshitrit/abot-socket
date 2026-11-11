import { randomUUID } from 'node:crypto';
import { notificationCursor } from './notification-input.mjs';
import { NotificationPreviewStore } from './notification-preview-store.mjs';

const MAX_ITEMS_PER_DEVICE = 500;
const SELECT_ITEM = `id, runtime_id AS runtimeId, session_id AS sessionId,
  request_id AS requestId, kind, created_at AS createdAt, read_at AS readAt, expires_at AS expiresAt`;

export class NotificationStore {
  constructor({ database, now = Date.now }) {
    this.database = database; this.now = now;
    this.previews = new NotificationPreviewStore({ database, now });
  }

  hasDevice(deviceId) {
    return Boolean(this.database.prepare('SELECT id FROM devices WHERE id = ? AND expires_at > ?')
      .get(deviceId, this.now()));
  }

  record(event, queueDelivery) {
    return this.database.transaction(() => {
      const device = this.database.prepare('SELECT expires_at FROM devices WHERE id = ? AND expires_at > ?')
        .get(event.deviceId, this.now());
      if (!device) return null;
      const item = { id: randomUUID(), ...event, readAt: null,
        expiresAt: Math.min(event.expiresAt, device.expires_at) };
      const added = this.database.prepare(`INSERT OR IGNORE INTO notifications
        (id, device_id, runtime_id, session_id, request_id, kind, approval_id, created_at, read_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.deviceId, item.runtimeId,
        item.sessionId, item.requestId, item.kind, item.approvalId, item.createdAt, item.readAt, item.expiresAt);
      if (!added.changes) return null;
      if (queueDelivery) {
        this.database.prepare('INSERT INTO notification_outbox(notification_id, next_at) VALUES (?, ?)')
          .run(item.id, this.now());
      }
      this.database.prepare(`DELETE FROM notifications WHERE device_id = ? AND id IN (
        SELECT id FROM notifications WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`)
        .run(item.deviceId, item.deviceId, MAX_ITEMS_PER_DEVICE);
      return item;
    });
  }

  list(deviceId, { limit = 50, before = null } = {}) {
    this.prune();
    const condition = before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const parameters = before ? [deviceId, before.createdAt, before.createdAt, before.id, limit + 1] : [deviceId, limit + 1];
    const rows = this.database.prepare(`SELECT ${SELECT_ITEM} FROM notifications WHERE device_id = ?
      ${condition} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters);
    const items = rows.slice(0, limit).map(row => ({ ...row }));
    const counts = this.counts(deviceId);
    return { items, nextCursor: rows.length > limit ? notificationCursor(items.at(-1)) : null, ...counts };
  }

  counts(deviceId) {
    const rows = this.database.prepare(`SELECT runtime_id, session_id, COUNT(*) AS count FROM notifications
      WHERE device_id = ? AND read_at IS NULL AND expires_at > ? GROUP BY runtime_id, session_id`).all(deviceId, this.now());
    const unreadByRuntime = Object.create(null);
    const unreadBySession = Object.create(null);
    let unreadCount = 0;
    for (const row of rows) {
      unreadCount += row.count;
      unreadByRuntime[row.runtime_id] = (unreadByRuntime[row.runtime_id] ?? 0) + row.count;
      unreadBySession[row.runtime_id] ??= Object.create(null);
      unreadBySession[row.runtime_id][row.session_id] = row.count;
    }
    return { unreadCount, unreadByRuntime, unreadBySession };
  }

  markRead(deviceId, ids) {
    return this.database.transaction(() => {
      const update = this.database.prepare('UPDATE notifications SET read_at = ? WHERE device_id = ? AND id = ? AND read_at IS NULL');
      let changes = 0;
      for (const id of ids) changes += update.run(this.now(), deviceId, id).changes;
      this.removeReadDeliveries();
      return changes > 0;
    });
  }

  closeApprovals(identity, approvalId) {
    const conditions = approvalId ? 'AND approval_id = ?' : '';
    const params = [this.now(), identity.deviceId, identity.runtimeId, identity.requestId];
    if (approvalId) params.push(approvalId);
    const changed = this.database.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?)
      WHERE device_id = ? AND runtime_id = ? AND request_id = ? AND kind = 'approval_required' ${conditions}`)
      .run(...params).changes;
    this.removeReadDeliveries();
    return changed > 0;
  }

  registration(deviceId) {
    const row = this.database.prepare('SELECT registration FROM notification_registrations WHERE device_id = ?').get(deviceId);
    return row ? JSON.parse(row.registration) : null;
  }

  register(deviceId, registration) {
    if (!this.hasDevice(deviceId)) return false;
    this.database.prepare(`INSERT INTO notification_registrations(device_id, provider, registration, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET provider = excluded.provider,
      registration = excluded.registration, updated_at = excluded.updated_at`)
      .run(deviceId, registration.provider, JSON.stringify(registration), this.now());
    return true;
  }

  unregister(deviceId, expectedRegistration) {
    this.database.transaction(() => {
      if (expectedRegistration && JSON.stringify(this.registration(deviceId)) !== JSON.stringify(expectedRegistration)) return;
      this.previews.removeKey(deviceId);
      this.database.prepare('DELETE FROM notification_registrations WHERE device_id = ?').run(deviceId);
      this.database.prepare(`DELETE FROM notification_outbox WHERE notification_id IN
        (SELECT id FROM notifications WHERE device_id = ?)` ).run(deviceId);
    });
  }

  removeReadDeliveries() {
    this.database.prepare(`DELETE FROM notification_outbox WHERE notification_id IN
      (SELECT id FROM notifications WHERE read_at IS NOT NULL)` ).run();
  }

  prune() {
    this.database.prepare('DELETE FROM notifications WHERE expires_at <= ?').run(this.now());
    this.database.prepare('DELETE FROM notifications WHERE NOT EXISTS (SELECT 1 FROM devices WHERE devices.id = notifications.device_id)').run();
    this.database.prepare('DELETE FROM notification_registrations WHERE NOT EXISTS (SELECT 1 FROM devices WHERE devices.id = notification_registrations.device_id)').run();
    this.database.prepare('DELETE FROM notification_registrations WHERE device_id IN (SELECT id FROM devices WHERE expires_at <= ?)').run(this.now());
    this.database.prepare('DELETE FROM notifications WHERE device_id IN (SELECT id FROM devices WHERE expires_at <= ?)').run(this.now());
    this.previews.prune();
  }

  forgetDevice(deviceId) {
    this.unregister(deviceId);
    this.database.prepare('DELETE FROM notifications WHERE device_id = ?').run(deviceId);
  }
}
