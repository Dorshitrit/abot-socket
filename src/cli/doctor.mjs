import { request as httpsRequest } from 'node:https';

const MAX_BODY_BYTES = 4096;
const MAX_ORIGIN_LENGTH = 2048;
const DEADLINE_MS = 5000;

function parseDoctorOrigin(value) {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_LENGTH) {
    throw new TypeError('Doctor requires a canonical HTTPS origin');
  }
  let origin;
  try { origin = new URL(value); } catch {
    throw new TypeError('Doctor requires a canonical HTTPS origin');
  }
  if (origin.protocol !== 'https:' || origin.origin !== value) {
    throw new TypeError('Doctor requires a canonical HTTPS origin');
  }
  return origin;
}

function hasOversizedDeclaredBody(response) {
  const length = response.headers['content-length'];
  if (length === undefined) return false;
  if (typeof length !== 'string' || !/^\d+$/.test(length)) return true;
  return Number(length) > MAX_BODY_BYTES;
}

function isRelayHealthResponse(chunks) {
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    return value.ok === true && value.version === 2;
  } catch { return false; }
}

/** Explicit public TLS check only. It never authenticates or probes a runtime. */
export async function checkPublicEndpoint(publicOrigin, {
  requestImpl = httpsRequest, timeoutMs = DEADLINE_MS,
} = {}) {
  const origin = parseDoctorOrigin(publicOrigin);
  if (typeof requestImpl !== 'function') throw new TypeError('An HTTPS request function is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) {
    throw new TypeError('Doctor deadline must be between 1 and 5000 milliseconds');
  }
  return new Promise((resolve) => {
    let request;
    let response;
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (response) {
        response.off('data', receiveData);
        response.off('end', receiveEnd);
        response.destroy();
      }
      request?.destroy();
      resolve({ ok: code === 'reachable', code, runtimeVerified: false });
    };
    const receiveData = (chunk) => {
      if (settled) return;
      if (!Buffer.isBuffer(chunk)) { finish('unexpected_response'); return; }
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { finish('unexpected_response'); return; }
      chunks.push(chunk);
    };
    const receiveEnd = () => {
      if (response.complete === false) { finish('unexpected_response'); return; }
      finish(isRelayHealthResponse(chunks) ? 'reachable' : 'unexpected_response');
    };
    const deadline = setTimeout(() => finish('timeout'), timeoutMs);
    const receiveResponse = (incoming) => {
      response = incoming;
      response.on('error', () => finish('https_unavailable'));
      response.on('aborted', () => finish('https_unavailable'));
      if (settled) { response.destroy(); return; }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        finish('redirect_rejected'); return;
      }
      if (response.statusCode !== 200) { finish('unexpected_response'); return; }
      const contentType = response.headers['content-type'];
      if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
        finish('unexpected_response'); return;
      }
      if (hasOversizedDeclaredBody(response)) { finish('unexpected_response'); return; }
      response.on('data', receiveData);
      response.once('end', receiveEnd);
    };
    try {
      request = requestImpl(new URL('/health', origin), {
        method: 'GET', headers: { Accept: 'application/json' },
        rejectUnauthorized: true, agent: false, maxHeaderSize: 8192,
      }, receiveResponse);
      request.on('error', () => finish('https_unavailable'));
      request.on('upgrade', (_incoming, socket) => {
        socket.destroy();
        finish('unexpected_response');
      });
      if (settled) { request.destroy(); return; }
      request.end();
    } catch { finish('https_unavailable'); }
  });
}
