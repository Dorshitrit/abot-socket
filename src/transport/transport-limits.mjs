export class WindowLimiter {
  constructor({ limit, windowMs, capacity = 1024, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.capacity = capacity;
    this.now = now;
    this.entries = new Map();
  }
  allow(key) {
    this.prune();
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.count >= this.limit) return false;
      entry.count += 1;
      return true;
    }
    if (this.entries.size >= this.capacity) return false;
    this.entries.set(key, { count: 1, until: this.now() + this.windowMs });
    return true;
  }
  prune() {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.until <= now) this.entries.delete(key);
  }
}

export function bearerToken(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43,128}$/.test(value)
    ? value.slice(7) : '';
}

export function sameAuthority(req, origin) {
  if (req.headers.host !== origin.host) return false;
  return req.headers.origin === undefined || req.headers.origin === origin.origin;
}

// Listener is loopback-only. The local reverse proxy MUST strip/overwrite this
// header using its verified client address, never copy arbitrary forwarded input.
export function trustedClientAddress(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return null;
  const address = req.headers['x-socket-client-ip'];
  return typeof address === 'string' && isIP(address) ? address : null;
}

export function jsonResponse(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

export async function readJson(req, maxBytes = 4096) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
    throw Object.assign(new Error('invalid_content_type'), { code: 'invalid_content_type', status: 415 });
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw Object.assign(new Error('payload_too_large'), { code: 'payload_too_large', status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error('payload_too_large'), { code: 'payload_too_large', status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json', status: 400 });
  }
}
import { isIP } from 'node:net';
