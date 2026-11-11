import { validateRuntimeGrants } from '../auth/runtime-credentials.mjs';
import { validateNotificationDeliveryConfiguration } from '../notifications/notification-delivery.mjs';

function isCanonicalHttpsOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' && origin.origin === value;
  } catch { return false; }
}

/** Pure preflight: no listener, credentials or state are created here. */
export function validateConfiguration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid configuration');
  }
  if (!isCanonicalHttpsOrigin(config.publicOrigin)) {
    throw new Error('Configure a canonical HTTPS publicOrigin');
  }
  const port = config.port ?? 8788;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid listener port');
  }
  if (typeof config.stateDirectory !== 'string' || !config.stateDirectory.trim() ||
      config.stateDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(config.stateDirectory)) {
    throw new Error('Configure a private stateDirectory');
  }
  if (Object.hasOwn(config, 'mail') || Object.hasOwn(config, 'allowedEmail')) {
    throw new Error('Email configuration is unsupported; create a pairing installation');
  }
  const notifications = config.notifications ?? {};
  if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications) ||
      Object.keys(notifications).some(key => key !== 'delivery')) {
    throw new Error('Invalid notification configuration');
  }
  return {
    publicOrigin: config.publicOrigin, port, stateDirectory: config.stateDirectory,
    runtimeGrants: validateRuntimeGrants(config.runtimeGrants),
    notifications: { delivery: validateNotificationDeliveryConfiguration(notifications.delivery) },
  };
}
