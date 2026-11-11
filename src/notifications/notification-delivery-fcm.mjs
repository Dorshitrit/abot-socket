import { sign } from 'node:crypto';
import { loadFcmServiceAccount } from './notification-delivery-credentials.mjs';
import { postNotificationRequest } from './notification-delivery-http.mjs';
import { isFcmDeviceToken, notificationEnvelope } from './notification-delivery-payload.mjs';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function createAssertion(account, now) {
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.clientEmail, scope: FCM_SCOPE, aud: OAUTH_URL, iat, exp: iat + 3600,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), account.key).toString('base64url')}`;
}

function hasInvalidDeviceResponse(response) {
  if (response.status !== 404) return false;
  const details = response.json?.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some((detail) => detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
    detail.errorCode === 'UNREGISTERED');
}

function hasExpiredEnvelope(envelope, now) {
  const expiry = Number(envelope?.apns?.headers?.['apns-expiration']);
  return Number.isSafeInteger(expiry) && expiry > 0 && expiry <= Math.floor(now / 1000);
}

function envelopeForDispatch(envelope, now) {
  if (!envelope.android) return envelope;
  const expiry = Number(envelope.apns?.headers?.['apns-expiration']);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) return envelope;
  return { ...envelope, android: { ...envelope.android,
    ttl: `${Math.max(0, expiry - Math.floor(now / 1000))}s` } };
}

/** Trusted gateway/socket code supplies a bounded, projected envelope. */
export function createFcmProvider(config, dependencies = {}) {
  const account = loadFcmServiceAccount(config.serviceAccountFile);
  const now = dependencies.now ?? Date.now;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`;
  let cachedToken;
  let tokenExpiresAt = 0;

  async function authorization(signal) {
    if (cachedToken && tokenExpiresAt > now() + 60_000) return cachedToken;
    const response = await postNotificationRequest(OAUTH_URL, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: createAssertion(account, now()) }).toString(),
    }, signal, dependencies);
    const token = response.json?.access_token;
    const duration = response.json?.expires_in;
    if (!response.ok || typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token) ||
        !Number.isSafeInteger(duration) || duration < 1 || duration > 3600) throw new Error();
    cachedToken = token;
    tokenExpiresAt = now() + duration * 1000;
    return token;
  }

  return Object.freeze({
    async sendEnvelope(deviceToken, envelope, signal) {
      if (!isFcmDeviceToken(deviceToken)) return { status: 'invalid' };
      try {
        if (!envelope || typeof envelope !== 'object' || Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 4096) {
          return { status: 'discarded' };
        }
        if (hasExpiredEnvelope(envelope, now())) return { status: 'discarded' };
        const token = await authorization(signal);
        if (signal?.aborted) return { status: 'retry' };
        if (hasExpiredEnvelope(envelope, now())) return { status: 'discarded' };
        const response = await postNotificationRequest(endpoint, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { ...envelopeForDispatch(envelope, now()), token: deviceToken } }),
        }, signal, dependencies);
        if (response.status === 401) { cachedToken = undefined; tokenExpiresAt = 0; }
        if (hasInvalidDeviceResponse(response)) return { status: 'invalid' };
        if (response.ok && typeof response.json?.name === 'string' && response.json.name.startsWith('projects/')) {
          return { status: 'delivered' };
        }
        return { status: 'retry' };
      } catch { return { status: 'retry' }; }
    },
  });
}

export function createFcmNotificationDelivery(config, dependencies = {}) {
  const provider = createFcmProvider(config, dependencies);
  const now = dependencies.now ?? Date.now;
  return Object.freeze({ mode: 'fcm', configured: true,
    async send({ registration, notification, badge }, signal) {
      if (registration?.provider !== 'fcm') return { status: 'invalid' };
      const envelope = notificationEnvelope(notification, badge, now());
      if (!envelope) return { status: 'discarded' };
      return provider.sendEnvelope(registration.token, envelope, signal);
    },
  });
}
