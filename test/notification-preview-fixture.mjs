import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { previewAdditionalData } from '../src/notifications/notification-preview-crypto.mjs';
export const previewVector = JSON.parse(readFileSync(new URL('./fixtures/notification-preview-v1.json', import.meta.url)));
export const previewKey = { keyId: previewVector.envelope.keyId, key: previewVector.key };
export function openPreview(envelope, notificationId, key = previewVector.key) {
  const combined = Buffer.from(envelope.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(envelope.nonce, 'base64url'));
  decipher.setAAD(previewAdditionalData(envelope.keyId, notificationId, envelope.expiresAt));
  decipher.setAuthTag(combined.subarray(-16));
  return Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8');
}
export function queuedPreview(database) {
  const row = database.prepare('SELECT notification_id, encrypted_preview FROM notification_outbox ORDER BY rowid LIMIT 1').get();
  return row ? { id: row.notification_id, preview: row.encrypted_preview ? JSON.parse(row.encrypted_preview) : null } : null;
}
