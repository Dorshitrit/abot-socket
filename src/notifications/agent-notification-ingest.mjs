import { createHash } from 'node:crypto';
import { agentNotificationKind } from '../protocol/agent-notification-protocol.mjs';

const MAX_RECEIPTS_PER_RUNTIME = 10_000;

/** Agent events are bound to authenticated Runtime transport and capable paired devices. */
export class AgentNotificationIngest {
  constructor({ store, delivery, changed }) {
    this.store = store; this.database = store.database; this.now = store.now;
    this.delivery = delivery; this.changed = changed;
  }

  capabilities(deviceId, agents) {
    const changed = this.database.transaction(() => {
      if (!this.store.hasDevice(deviceId)) return false;
      if (agents) {
        this.database.prepare(`INSERT OR IGNORE INTO notification_client_capabilities(device_id, agents_enabled_at)
          VALUES (?, ?)`).run(deviceId, this.now());
        return true;
      }
      this.database.prepare('DELETE FROM notification_client_capabilities WHERE device_id = ?').run(deviceId);
      this.database.prepare(`DELETE FROM notification_outbox WHERE notification_id IN
        (SELECT id FROM notifications WHERE device_id = ? AND target = 'agent')`).run(deviceId);
      return true;
    });
    return changed;
  }

  supportsAgents(deviceId) {
    return Boolean(this.database.prepare(`SELECT c.device_id FROM notification_client_capabilities c
      JOIN devices d ON d.id = c.device_id WHERE c.device_id = ? AND d.expires_at > ?`).get(deviceId, this.now()));
  }

  observe(runtimeId, event) {
    // A valid expired event is acknowledged without creating a late notification.
    if (event.expiresAt <= this.now()) return true;
    const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const changed = [];
    const accepted = this.database.transaction(() => {
      this.prune();
      const previous = this.database.prepare(`SELECT fingerprint FROM agent_notification_receipts
        WHERE runtime_id = ? AND event_id = ?`).get(runtimeId, event.eventId);
      if (previous) return previous.fingerprint === fingerprint;
      const count = this.database.prepare(`SELECT COUNT(*) AS n FROM agent_notification_receipts WHERE runtime_id = ?`)
        .get(runtimeId).n;
      if (count >= MAX_RECEIPTS_PER_RUNTIME) return false;
      const devices = this.database.prepare(`SELECT d.id FROM devices d
        JOIN notification_client_capabilities c ON c.device_id = d.id
        WHERE d.subject = ? AND d.expires_at > ? AND d.created_at <= ? AND c.agents_enabled_at <= ?`)
        .all(this.database.ownerId, this.now(), event.createdAt, event.createdAt);
      for (const device of devices) {
        const registration = this.store.registration(device.id);
        const queue = this.delivery.configured && registration?.provider === this.delivery.mode;
        const item = this.store.recordInTransaction({ deviceId: device.id, runtimeId,
          target: 'agent', agentId: event.agentId, missionId: event.missionId,
          messageId: event.messageId ?? null, sourceEventId: event.eventId, reason: event.reason,
          sessionId: null, requestId: null, kind: agentNotificationKind(event.reason), approvalId: '',
          createdAt: event.createdAt, expiresAt: event.expiresAt }, queue);
        if (item && queue) this.store.previews.attach(item, event.output);
        if (item) changed.push(device.id);
      }
      this.database.prepare(`INSERT INTO agent_notification_receipts(runtime_id, event_id, fingerprint, expires_at)
        VALUES (?, ?, ?, ?)`).run(runtimeId, event.eventId, fingerprint, event.expiresAt);
      return true;
    });
    for (const deviceId of changed) this.changed(deviceId);
    return accepted;
  }

  prune() {
    this.database.prepare('DELETE FROM agent_notification_receipts WHERE expires_at <= ?').run(this.now());
  }
}
