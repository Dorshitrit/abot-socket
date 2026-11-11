import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingQrPayload } from '../src/pairing/pairing-qr-payload.mjs';

const pairing = Object.freeze({
  serverUrl: 'https://socket.example.test:9443',
  pairingId: 'a'.repeat(32),
  code: '000123',
  expiresAt: 1_800_000_300_000,
});

test('QR carries the exact existing pairing credentials, including leading zeros', () => {
  assert.deepEqual(JSON.parse(pairingQrPayload(pairing)), {
    type: 'abot-pairing', version: 1, ...pairing,
  });
});

test('QR serializes only the pairing allowlist and never operator/runtime secrets', () => {
  const input = { ...pairing, runtimeToken: 'private-runtime-token', token: 'private-device-token',
    configPath: '/private/operator/config.json', unrelated: { secret: 'private-field' } };
  const encoded = pairingQrPayload(input);
  assert.equal(encoded, pairingQrPayload(pairing));
  assert.equal(encoded.includes('private'), false);
  assert.equal(input.runtimeToken, 'private-runtime-token');
});

test('QR rejects malformed, non-HTTPS and non-canonical origins without echoing secrets', () => {
  const invalid = [null, undefined, [], {},
    ...['http://socket.example.test', 'https://user:secret@socket.example.test',
      'https://socket.example.test/path', 'https://socket.example.test?key=secret',
      'https://socket.example.test#secret', 'https://socket.example.test/',
      `https://${'a'.repeat(2049)}.test`].map(serverUrl => ({ ...pairing, serverUrl })),
    ...[123, '12345', '1234567', 'abcdef'].map(code => ({ ...pairing, code })),
    ...['short', 'a'.repeat(33), '!'.repeat(32)].map(pairingId => ({ ...pairing, pairingId })),
    ...[0, -1, 1.5, Infinity, '1800000300000'].map(expiresAt => ({ ...pairing, expiresAt })),
  ];
  for (const value of invalid) assert.throws(() => pairingQrPayload(value), {
    message: 'Invalid pairing QR details',
  });
});
