import { createCipheriv, randomBytes } from 'node:crypto';
import { MAX_PREVIEW_BYTES } from './notification-preview-text.mjs';

const MAX_AGE_MS = 7 * 86_400_000;
const ENVELOPE_KEYS = ['v', 'keyId', 'nonce', 'ciphertext', 'expiresAt'];
export function previewBase64Bytes(value, size, maximum = size) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < size || bytes.length > maximum || bytes.toString('base64url') !== value) return null;
  return bytes;
}

export function hasPreviewKey(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.keys(value).every(key => ['keyId', 'key'].includes(key)) &&
    previewBase64Bytes(value.keyId, 16) && previewBase64Bytes(value.key, 32));
}

export function previewAdditionalData(keyId, notificationId, expiresAt) {
  return Buffer.from(`ABot push preview v1\n${keyId}\n${notificationId}\n${expiresAt}`, 'utf8');
}

export function validatedNotificationPreview(value, notification, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length !== ENVELOPE_KEYS.length || Object.keys(value).some(key => !ENVELOPE_KEYS.includes(key))) return null;
  if (value.v !== 1 || notification?.kind !== 'completed') return null;
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt !== notification.expiresAt ||
      value.expiresAt <= now || value.expiresAt > now + MAX_AGE_MS) return null;
  if (!previewBase64Bytes(value.keyId, 16) || !previewBase64Bytes(value.nonce, 12) ||
      !previewBase64Bytes(value.ciphertext, 17, MAX_PREVIEW_BYTES + 16)) return null;
  return { v: 1, keyId: value.keyId, nonce: value.nonce, ciphertext: value.ciphertext, expiresAt: value.expiresAt };
}

export function sealNotificationPreview(keyId, key, notification, text, nonce = randomBytes(12)) {
  if (!previewBase64Bytes(keyId, 16) || key.length !== 32 || nonce.length !== 12 || typeof text !== 'string' ||
      !text || Buffer.byteLength(text, 'utf8') > MAX_PREVIEW_BYTES) throw new Error('Invalid notification preview');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(previewAdditionalData(keyId, notification.id, notification.expiresAt));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, keyId, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
    expiresAt: notification.expiresAt };
}
