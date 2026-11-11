export const MAX_PREVIEW_BYTES = 1024;
const SOURCE_PREFIX = 8192;
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** A bounded display excerpt, never a transcript or a claim to redact secrets. */
export function notificationPreviewText(output) {
  if (typeof output !== 'string') return null;
  const clean = [...output.slice(0, SOURCE_PREFIX).replace(/\r\n?/gu, '\n').replace(UNSAFE, '')]
    .filter(char => { const code = char.codePointAt(0); return code < 0xd800 || code > 0xdfff; }).join('').trim();
  if (!clean) return null;
  const truncated = output.length > SOURCE_PREFIX || Buffer.byteLength(clean, 'utf8') > MAX_PREVIEW_BYTES;
  if (!truncated) return clean;
  let text = ''; let bytes = 0;
  for (const char of clean) {
    const length = Buffer.byteLength(char, 'utf8');
    if (bytes + length > MAX_PREVIEW_BYTES - 3) break;
    text += char; bytes += length;
  }
  return `${text.trimEnd()}…`;
}
