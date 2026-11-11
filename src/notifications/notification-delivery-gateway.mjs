import { postNotificationRequest } from './notification-delivery-http.mjs';
import { notificationEnvelope } from './notification-delivery-payload.mjs';
import { validatedNotificationPreview } from './notification-preview-crypto.mjs';

function hasGatewayRegistration(registration) {
  if (registration?.provider !== 'gateway') return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(registration.endpointId ?? '')) return false;
  return /^[A-Za-z0-9_-]{32,512}$/.test(registration.sendToken ?? '');
}

function hasInvalidGatewayRecipient(response) {
  if (response.status === 401 && response.json?.error === 'unauthorized') return true;
  return response.status === 410 && response.json?.error === 'endpoint_unavailable';
}

export function createGatewayNotificationDelivery(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const endpoint = `${config.gatewayOrigin}/v1/deliver`;
  return Object.freeze({ mode: 'gateway', configured: true,
    async send({ registration, notification, badge }, signal) {
      if (!hasGatewayRegistration(registration)) return { status: 'invalid' };
      if (!notificationEnvelope(notification, badge, now())) return { status: 'discarded' };
      const preview = validatedNotificationPreview(notification.preview, notification, now());
      try {
        const response = await postNotificationRequest(endpoint, {
          headers: { Authorization: `Bearer ${registration.sendToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpointId: registration.endpointId, notificationId: notification.id,
            kind: notification.kind, expiresAt: notification.expiresAt, badge, ...(preview ? { preview } : {}) }),
        }, signal, dependencies);
        if (hasInvalidGatewayRecipient(response)) return { status: 'invalid' };
        if (response.ok && response.json?.ok === true) return { status: 'delivered' };
        return { status: 'retry' };
      } catch { return { status: 'retry' }; }
    },
  });
}
