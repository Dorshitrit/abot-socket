import { NotificationStore } from './notification-store.mjs';
import { NotificationOutbox } from './notification-outbox.mjs';
import { closesApprovalNotifications, projectNotificationEvent } from './notification-projection.mjs';
import { notificationInputError } from './notification-input.mjs';

const PRESENCE_MS = 45_000;

/** Notification lifecycle is independent of a selected runtime or a live mobile socket. */
export class NotificationService {
  constructor({ database, delivery, now = Date.now, onChanged = () => {} }) {
    this.store = new NotificationStore({ database, now });
    this.outbox = new NotificationOutbox({ database, now });
    this.delivery = delivery;
    this.now = now;
    this.onChanged = onChanged;
    this.presence = new Map();
    this.closed = false;
    this.pending = null;
    this.active = null;
  }

  changed(deviceId) {
    try { this.onChanged(deviceId); } catch { /* Invalidation is best effort; HTTP is canonical. */ }
  }

  observe(identity, body) {
    let changed = false;
    if (closesApprovalNotifications(body)) {
      changed = this.store.closeApprovals(identity, body.type === 'event' ? body.approvalId : undefined);
      if (this.active?.entry.notification.kind === 'approval_required' &&
        this.active.entry.deviceId === identity.deviceId &&
        this.active.entry.notification.runtimeId === identity.runtimeId &&
        this.active.entry.notification.requestId === identity.requestId) this.active.controller.abort();
    }
    const projected = projectNotificationEvent(identity, body, this.now());
    if (projected) {
      const registration = this.store.registration(identity.deviceId);
      const queue = this.delivery.configured && registration?.provider === this.delivery.mode;
      const item = this.store.record(projected, queue);
      if (item && queue) this.store.previews.attach(item, body.output);
      changed = Boolean(item) || changed;
    }
    if (changed) this.changed(identity.deviceId);
  }

  list(deviceId, options) {
    const registration = this.store.registration(deviceId);
    return { version: 1, ...this.store.list(deviceId, options),
      delivery: { mode: this.delivery.mode, configured: this.delivery.configured },
      registration: { enabled: this.delivery.configured && registration?.provider === this.delivery.mode },
      preview: this.store.previews.status(deviceId) };
  }

  markRead(deviceId, ids) {
    if (this.active?.entry.deviceId === deviceId && ids.includes(this.active.entry.notification.id)) {
      this.active.controller.abort();
    }
    if (this.store.markRead(deviceId, ids)) this.changed(deviceId);
  }

  updatePresence(deviceId, presence) {
    if (!presence.foreground) { this.presence.delete(deviceId); return; }
    this.presence.set(deviceId, { ...presence, expiresAt: this.now() + PRESENCE_MS });
    // Advisory only: iOS may suspend before a background update is delivered.
    // Only an explicit read acknowledgement can consume an unseen notification.
  }

  register(deviceId, registration) {
    if (!this.delivery.configured || registration.provider !== this.delivery.mode) {
      throw notificationInputError('push_unavailable', 409);
    }
    if (this.active?.entry.deviceId === deviceId) this.active.controller.abort();
    if (!this.store.register(deviceId, registration)) throw notificationInputError('unauthorized', 401);
  }

  enablePreview(deviceId, key) {
    const registration = this.store.registration(deviceId);
    if (!this.delivery.configured || registration?.provider !== this.delivery.mode) {
      throw notificationInputError('push_unavailable', 409);
    }
    if (this.active?.entry.deviceId === deviceId) this.active.controller.abort();
    if (!this.store.previews.enable(deviceId, key)) throw notificationInputError('unauthorized', 401);
  }

  disablePreview(deviceId) {
    if (this.active?.entry.deviceId === deviceId) this.active.controller.abort();
    this.store.previews.disable(deviceId);
  }

  unregister(deviceId) {
    if (this.active?.entry.deviceId === deviceId) this.active.controller.abort();
    this.store.unregister(deviceId);
  }

  revoke(deviceId) {
    if (this.active?.entry.deviceId === deviceId) this.active.controller.abort();
    this.presence.delete(deviceId);
    this.store.forgetDevice(deviceId);
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 1_000);
    this.timer.unref();
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.drain().catch(() => { /* Durable entries remain for a later bounded attempt. */ })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async drain() {
    this.store.prune();
    for (const [deviceId, presence] of this.presence) {
      if (presence.expiresAt <= this.now()) this.presence.delete(deviceId);
    }
    if (!this.delivery.configured) return;
    for (let index = 0; index < 10 && !this.closed; index += 1) {
      const entry = this.outbox.claim(this.delivery.mode);
      if (!entry) return;
      if (!this.outbox.canDeliver(entry)) continue;
      const controller = new AbortController();
      this.active = { entry, controller };
      let result;
      try {
        result = await this.delivery.send({ registration: entry.registration, notification: entry.notification,
          badge: this.store.counts(entry.deviceId).unreadCount }, controller.signal);
      } catch { result = { status: 'retry' }; }
      this.active = null;
      if (controller.signal.aborted) { this.outbox.cancel(entry); continue; }
      const status = ['delivered', 'invalid', 'discarded', 'retry'].includes(result?.status) ? result.status : 'retry';
      if (status === 'invalid') this.store.unregister(entry.deviceId, entry.registration);
      this.outbox.finish(entry, status);
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    await this.pending;
    this.presence.clear();
  }
}
