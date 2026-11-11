import { createFcmNotificationDelivery } from './notification-delivery-fcm.mjs';
import { createGatewayNotificationDelivery } from './notification-delivery-gateway.mjs';

function hasOnlyDeliveryKeys(config, keys) {
  return Object.keys(config).every((key) => keys.includes(key));
}

function isCanonicalGatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch { return false; }
}

/** Pure config validation: credentials are opened only when constructing a sender. */
export function validateNotificationDeliveryConfiguration(config = { type: 'disabled' }) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid notification delivery configuration');
  }
  if (config.type === 'disabled' && hasOnlyDeliveryKeys(config, ['type'])) {
    return { type: 'disabled' };
  }
  if (config.type === 'fcm' && hasOnlyDeliveryKeys(config, ['type', 'serviceAccountFile'])) {
    const path = config.serviceAccountFile;
    if (typeof path === 'string' && path.trim() && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)) {
      return { type: 'fcm', serviceAccountFile: path };
    }
  }
  if (config.type === 'gateway' && hasOnlyDeliveryKeys(config, ['type', 'gatewayOrigin']) &&
      isCanonicalGatewayOrigin(config.gatewayOrigin)) {
    return { type: 'gateway', gatewayOrigin: config.gatewayOrigin };
  }
  throw new Error('Invalid notification delivery configuration');
}

export function createNotificationDelivery(config, dependencies = {}) {
  const validated = validateNotificationDeliveryConfiguration(config);
  if (validated.type === 'fcm') return createFcmNotificationDelivery(validated, dependencies);
  if (validated.type === 'gateway') return createGatewayNotificationDelivery(validated, dependencies);
  return Object.freeze({ mode: 'disabled', configured: false,
    send: async () => ({ status: 'retry' }) });
}
