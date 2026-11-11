const MAX_RESPONSE_BYTES = 16 * 1024;

function abortFailure() { return new Error('Notification delivery interrupted'); }

function waitForResponse(promise, signal) {
  if (signal.aborted) return Promise.reject(abortFailure());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortFailure());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBoundedJson(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error();
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await waitForResponse(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(Buffer.from(value));
    }
    if (!size) return null;
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Destination is constructed by an adapter, never from a mobile registration. */
export async function postNotificationRequest(url, init, signal,
  { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const deadline = setTimeout(() => timeout.abort(), Math.min(Math.max(timeoutMs, 1), 10_000));
  try {
    if (combined.aborted) throw abortFailure();
    const response = await waitForResponse(fetchImpl(url, { ...init,
      method: 'POST', redirect: 'error', signal: combined }), combined);
    if (response.status >= 300 && response.status < 400) throw new Error();
    const json = await readBoundedJson(response, combined);
    return { status: response.status, ok: response.ok, json };
  } catch {
    timeout.abort();
    throw new Error('Notification provider unavailable');
  } finally { clearTimeout(deadline); }
}
