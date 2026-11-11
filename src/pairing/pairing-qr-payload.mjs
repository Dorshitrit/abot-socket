/** Public format for an operator-issued, short-lived pairing QR. Never a URL. */
export const PAIRING_QR_TYPE = 'abot-pairing';
export const PAIRING_QR_VERSION = 1;

function hasCanonicalPairingOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch { return false; }
}

function hasPairingCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!hasCanonicalPairingOrigin(value.serverUrl)) return false;
  if (typeof value.pairingId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.pairingId)) return false;
  if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) return false;
  return Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}

export function pairingQrPayload(pairing) {
  if (!hasPairingCredentials(pairing)) throw new Error('Invalid pairing QR details');
  // Explicit selection keeps runtime tokens and future operator-only fields out.
  return JSON.stringify({
    type: PAIRING_QR_TYPE,
    version: PAIRING_QR_VERSION,
    serverUrl: pairing.serverUrl,
    pairingId: pairing.pairingId,
    code: pairing.code,
    expiresAt: pairing.expiresAt,
  });
}
