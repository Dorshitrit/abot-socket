import { createServer } from 'node:http';
import { bearerToken, jsonResponse, readJson, sameAuthority, trustedClientAddress, WindowLimiter } from '../transport/transport-limits.mjs';
import { validatedNotificationPreview } from './notification-preview-crypto.mjs';
import { NotificationGatewayStore } from './notification-gateway-store.mjs';
import { isFcmDeviceToken, notificationEnvelope } from './notification-delivery-payload.mjs';

const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const isSecret = (value) => typeof value === 'string' && SECRET.test(value);
const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value);

function hasExactKeys(body, keys) {
  return Object.keys(body).length === keys.length && Object.keys(body).every((key) => keys.includes(key));
}

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value) return url;
  } catch { /* Reject malformed origins without exposing them. */ }
  throw new Error('Gateway requires a canonical HTTPS publicOrigin');
}

/** Separate trusted sender process. This is not the user's chat relay. */
export function createNotificationGateway({ stateDirectory, publicOrigin, sendProviderEnvelope, now = Date.now }) {
  const origin = canonicalOrigin(publicOrigin);
  if (typeof sendProviderEnvelope !== 'function') throw new Error('Gateway requires a notification provider');
  const store = new NotificationGatewayStore({ stateDirectory, now });
  const shutdown = new AbortController();
  const sources = new WindowLimiter({ limit: 120, windowMs: 60_000, now });
  const enrollment = new WindowLimiter({ limit: 5, windowMs: 60 * 60_000, now });
  const enrollmentTotal = new WindowLimiter({ limit: 1000, windowMs: 86_400_000, capacity: 1, now });
  const endpointRate = new WindowLimiter({ limit: 30, windowMs: 60_000, now });
  const activeDeliveries = new Map();
  const activeHandlers = new Set();

  async function sendEnvelope(token, envelope, signal = shutdown.signal) {
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), 10_000);
    let onAbort;
    try {
      if (combined.aborted) return { status: 'retry' };
      const interrupted = new Promise((resolve) => {
        onAbort = () => resolve({ status: 'retry' });
        combined.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([sendProviderEnvelope(token, envelope, combined), interrupted]);
    } catch { return { status: 'retry' }; }
    finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener('abort', onAbort);
    }
  }

  async function enroll(body, sourceId) {
    if (!hasExactKeys(body, ['token']) || !isFcmDeviceToken(body.token)) throw failure('invalid_request');
    if (!enrollment.allow(sourceId) || !enrollmentTotal.allow('gateway')) throw failure('rate_limited', 429);
    const challenge = store.createChallenge(body.token);
    const result = await sendEnvelope(body.token, {
      data: { abotPushChallenge: challenge.challengeId, proof: challenge.proof },
      android: { priority: 'NORMAL',
        ttl: `${Math.max(0, Math.floor((challenge.expiresAt - now()) / 1000))}s` },
      apns: { headers: { 'apns-push-type': 'background', 'apns-priority': '5',
        'apns-expiration': String(Math.floor(challenge.expiresAt / 1000)) },
      payload: { aps: { 'content-available': 1 } } },
    });
    if (result.status !== 'delivered') {
      store.removeChallenge(challenge.challengeId);
      throw failure('provider_unavailable', 503);
    }
    return { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt };
  }

  function confirm(body) {
    if (!hasExactKeys(body, ['challengeId', 'proof']) || !isSecret(body.challengeId) || !isSecret(body.proof)) {
      throw failure('invalid_request');
    }
    const grant = store.confirm(body.challengeId, body.proof);
    if (!grant) throw failure('unauthorized', 401);
    return grant;
  }

  async function deliver(body, credential) {
    const keys = ['endpointId', 'notificationId', 'kind', 'expiresAt', 'badge'];
    if (Object.hasOwn(body, 'preview')) keys.push('preview');
    if (!hasExactKeys(body, keys) ||
        !isSecret(body.endpointId) || !isIdentifier(body.notificationId)) throw failure('invalid_request');
    const endpoint = store.authorize(body.endpointId, credential);
    if (!endpoint) throw failure('unauthorized', 401);
    const notification = { id: body.notificationId, kind: body.kind, expiresAt: body.expiresAt };
    if (body.expiresAt > now() + 7 * 86_400_000) throw failure('invalid_request');
    if (Object.hasOwn(body, 'preview')) {
      notification.preview = validatedNotificationPreview(body.preview, notification, now());
      if (!notification.preview) throw failure('invalid_request');
    }
    const envelope = notificationEnvelope(notification, body.badge, now());
    if (!envelope) throw failure('invalid_request');
    if (!endpointRate.allow(endpoint.id)) throw failure('rate_limited', 429);
    const claim = store.claimDelivery(endpoint.id, notification.id, notification.expiresAt);
    if (claim === 'done') return { ok: true };
    if (claim === 'busy') throw failure('delivery_pending', 503);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, shutdown.signal]);
    const deliveryKey = `${endpoint.id}:${notification.id}`;
    activeDeliveries.set(deliveryKey, { endpointId: endpoint.id, controller });
    let result;
    try { result = await sendEnvelope(endpoint.token, envelope, signal); }
    finally { activeDeliveries.delete(deliveryKey); }
    if (result.status === 'invalid') {
      store.removeInvalidEndpoint(endpoint.id);
      throw failure('endpoint_unavailable', 410);
    }
    store.finishDelivery(endpoint.id, notification.id, result.status === 'delivered');
    if (result.status !== 'delivered') throw failure('provider_unavailable', 503);
    return { ok: true };
  }

  function revoke(body, credential) {
    if (!hasExactKeys(body, ['endpointId']) || !isSecret(body.endpointId)) throw failure('invalid_request');
    if (!store.revoke(body.endpointId, credential)) throw failure('unauthorized', 401);
    for (const delivery of activeDeliveries.values()) {
      if (delivery.endpointId === body.endpointId) delivery.controller.abort();
    }
    return { ok: true };
  }

  async function handleRequest(req, res) {
    try {
      if (shutdown.signal.aborted) throw failure('unavailable', 503);
      if (!sameAuthority(req, origin) || req.headers['x-forwarded-proto'] !== 'https') throw failure('forbidden', 403);
      const sourceId = trustedClientAddress(req);
      if (!sourceId) throw failure('forbidden', 403);
      if (!sources.allow(sourceId)) throw failure('rate_limited', 429);
      if (req.method === 'GET' && req.url === '/health') return jsonResponse(res, 200, { ok: true });
      if (req.method !== 'POST') throw failure('not_found', 404);
      const body = await readJson(req, 8192);
      if (req.url === '/v1/enroll') return jsonResponse(res, 200, await enroll(body, sourceId));
      if (req.url === '/v1/confirm') return jsonResponse(res, 200, confirm(body));
      if (req.url === '/v1/deliver') return jsonResponse(res, 200, await deliver(body, bearerToken(req)));
      if (req.url === '/v1/revoke') return jsonResponse(res, 200, revoke(body, bearerToken(req)));
      throw failure('not_found', 404);
    } catch (error) {
      const status = [400, 401, 403, 404, 410, 413, 415, 429, 503].includes(error.status) ? error.status : 500;
      const code = status === 500 ? 'internal_error' : error.code;
      if (!res.headersSent && !res.destroyed) jsonResponse(res, status, { error: code });
    }
  }

  function handler(req, res) {
    const operation = handleRequest(req, res);
    activeHandlers.add(operation);
    void operation.finally(() => activeHandlers.delete(operation));
    return operation;
  }

  const server = createServer(handler);
  server.requestTimeout = 15_000; server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000; server.maxHeadersCount = 32; server.maxConnections = 32;
  const sweep = setInterval(() => {
    store.prune(); sources.prune(); enrollment.prune(); enrollmentTotal.prune(); endpointRate.prune();
  }, 30_000);
  sweep.unref();
  let closed = false;
  return {
    handler,
    listen: (port = 8789) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => {
      if (closed) { resolve(); return; }
      closed = true; clearInterval(sweep); shutdown.abort();
      server.closeAllConnections();
      server.close(() => {
        void Promise.allSettled([...activeHandlers]).then(() => { store.close(); resolve(); });
      });
    }),
  };
}
