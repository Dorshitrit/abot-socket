import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPreviewText } from '../src/notifications/notification-preview-text.mjs';
import { hasPreviewKey, sealNotificationPreview, validatedNotificationPreview } from '../src/notifications/notification-preview-crypto.mjs';
import { previewVector as vector, previewKey, openPreview } from './notification-preview-fixture.mjs';

const notification = { id: vector.notificationId, kind: 'completed', expiresAt: vector.envelope.expiresAt };
test('AES-GCM matches the shared Unicode native vector and binds notification, recipient and expiry', () => {
  const sealed = sealNotificationPreview(previewKey.keyId, Buffer.from(previewKey.key, 'base64url'),
    notification, vector.plaintext, Buffer.from(vector.envelope.nonce, 'base64url'));
  assert.deepEqual(sealed, vector.envelope);
  assert.equal(openPreview(sealed, notification.id), vector.plaintext);
  for (const changed of [{ ...sealed, keyId: 'b'.repeat(22) }, { ...sealed, expiresAt: sealed.expiresAt + 1 },
    { ...sealed, ciphertext: `${sealed.ciphertext[0] === 'A' ? 'B' : 'A'}${sealed.ciphertext.slice(1)}` }]) {
    assert.throws(() => openPreview(changed, notification.id));
  }
  assert.throws(() => openPreview(sealed, `${notification.id}-other`));
  assert.throws(() => openPreview(sealed, notification.id, Buffer.alloc(32, 42).toString('base64url')));
});

test('preview inputs enforce exact canonical encodings, expiry, kind and size', () => {
  assert.equal(hasPreviewKey(previewKey), true);
  for (const input of [{ ...previewKey, key: `${previewKey.key}=` }, { ...previewKey, keyId: 'A'.repeat(21) },
    { ...previewKey, private: 'extra' }, { ...previewKey, key: ' '.repeat(43) }, null]) assert.equal(hasPreviewKey(input), false);
  assert.deepEqual(validatedNotificationPreview(vector.envelope, notification, vector.now), vector.envelope);
  for (const envelope of [{ ...vector.envelope, v: 2 }, { ...vector.envelope, plaintext: 'private' },
    { ...vector.envelope, ciphertext: Buffer.alloc(1041).toString('base64url') },
    { ...vector.envelope, ciphertext: Buffer.alloc(16).toString('base64url') },
    { ...vector.envelope, nonce: `${vector.envelope.nonce}=` },
    { ...vector.envelope, expiresAt: notification.expiresAt + 1 }]) {
    assert.equal(validatedNotificationPreview(envelope, notification, vector.now), null);
  }
  assert.equal(validatedNotificationPreview(vector.envelope, notification, notification.expiresAt), null);
  assert.equal(validatedNotificationPreview(vector.envelope, notification, notification.expiresAt - 8 * 86_400_000), null);
  assert.equal(validatedNotificationPreview(vector.envelope, { ...notification, kind: 'failed' }, vector.now), null);
});

test('final excerpts remove unsafe controls without breaking Unicode or newlines and stay bounded', () => {
  assert.equal(notificationPreviewText('\u0000שלום\u202e ABot\r\n👋\ud800'), 'שלום ABot\n👋');
  assert.equal(notificationPreviewText(' \n\u2066\u2069\u0000 '), null);
  assert.equal(notificationPreviewText({ output: 'not text' }), null);
  assert.equal(notificationPreviewText('a'.repeat(1024)), 'a'.repeat(1024));
  for (const input of ['a'.repeat(1025), 'שלום👋'.repeat(2000), '\u0000'.repeat(9000) + 'later']) {
    const text = notificationPreviewText(input);
    if (text === null) continue;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 1024);
    assert.ok(text.endsWith('…'));
    assert.ok(!text.includes('\ufffd'));
    assert.equal(Buffer.from(text).toString('utf8'), text);
  }
});
