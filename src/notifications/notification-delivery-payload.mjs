import { validatedNotificationPreview } from './notification-preview-crypto.mjs';

const TEXT = Object.freeze({
  completed: 'Your response is ready.',
  failed: 'Your request needs attention.',
  approval_required: 'A request is waiting for your approval.',
});

export function notificationEnvelope(notification, badge, now) {
  if (!notification || typeof notification.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(notification.id)) return null;
  if (typeof notification.kind !== 'string' || !Object.hasOwn(TEXT, notification.kind)) return null;
  if (!Number.isSafeInteger(notification.expiresAt) || notification.expiresAt <= now) return null;
  if (!Number.isSafeInteger(badge) || badge < 0 || badge > 100_000) return null;
  // The notification is only a hint. Destinations/content are loaded from the
  // current authenticated server after the app opens, never trusted from push.
  const envelope = {
    notification: { title: 'ABot', body: TEXT[notification.kind] },
    data: { notificationId: notification.id },
    android: {
      priority: 'HIGH',
      ttl: `${Math.max(0, Math.floor(Math.min(notification.expiresAt - now, 7 * 86_400_000) / 1000))}s`,
      notification: { channel_id: 'abot_updates', tag: notification.id,
        notification_count: badge, default_sound: true },
    },
    apns: {
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(Math.min(notification.expiresAt, now + 7 * 86_400_000) / 1000)) },
      payload: { aps: { badge, sound: 'default' } },
    },
  };
  const preview = validatedNotificationPreview(notification.preview, notification, now);
  if (preview) {
    delete envelope.notification;
    delete envelope.android.notification;
    envelope.data = { notificationId: notification.id, abotPreview: JSON.stringify(preview),
      abotKind: 'completed', abotExpiresAt: String(notification.expiresAt), abotBadge: String(badge) };
    envelope.apns.payload.aps.alert = { title: 'ABot', body: TEXT.completed };
    envelope.apns.payload.aps['mutable-content'] = 1;
  }
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= 4096 ? envelope : null;
}

export function isFcmDeviceToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_:.-]{16,4096}$/.test(token);
}
