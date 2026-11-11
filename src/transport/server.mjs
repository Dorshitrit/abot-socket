import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthService } from '../auth/auth.mjs';
import { Relay } from '../relay/relay.mjs';
import { handleHttpApi } from './http-api.mjs';
import { WindowLimiter, sameAuthority, jsonResponse, bearerToken, trustedClientAddress } from './transport-limits.mjs';
import { resolveRuntimeCredential, validateRuntimeGrants } from '../auth/runtime-credentials.mjs';
import { clientCapabilities } from '../cli/client-capabilities.mjs';
import { AuthDatabase } from '../auth/auth-database.mjs';
import { NotificationService } from '../notifications/notification-service.mjs';
import { createNotificationDelivery } from '../notifications/notification-delivery.mjs';

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_CONNECTIONS = 32;

export function createSocketServer({ stateDirectory, runtimeGrants: grants,
  publicOrigin, tls, now = Date.now, notifications: notificationConfig, notificationDelivery }) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) throw new Error('HTTPS origin required');
  const runtimeGrants = validateRuntimeGrants(grants);
  const database = new AuthDatabase(stateDirectory);
  let auth;
  let notifications;
  try {
    auth = new AuthService({ database, now });
    notifications = new NotificationService({ database, now,
      delivery: notificationDelivery ?? createNotificationDelivery(notificationConfig?.delivery ?? { type: 'disabled' }) });
  } catch (error) {
    auth?.close(); database.close(); throw error;
  }
  const peers = new Map();
  const upgrades = new WindowLimiter({ limit: 30, windowMs: 60_000, now });
  const requests = new WindowLimiter({ limit: 120, windowMs: 60_000, now });
  const close = (peer, code = 1008, reason = 'Access denied') => {
    if (peer.readyState === WebSocket.OPEN) peer.close(code, reason);
    else peer.terminate();
  };
  const send = (peer, payload) => {
    const context = peers.get(peer);
    if (context?.role === 'client' && !auth.authenticate(context.token)) {
      close(peer); return false;
    }
    if (peer.readyState !== WebSocket.OPEN) return false;
    let encoded;
    try { encoded = JSON.stringify(payload); } catch { return false; }
    if (Buffer.byteLength(encoded) > MAX_FRAME || peer.bufferedAmount + Buffer.byteLength(encoded) > MAX_BUFFER) {
      close(peer, 1013, 'Receiver capacity exceeded'); return false;
    }
    peer.send(encoded, (error) => { if (error) peer.terminate(); });
    return true;
  };
  const relay = new Relay({ now, send, close, observeRequest: (identity, body) => notifications.observe(identity, body) });
  const authorityAccepted = (req) => sameAuthority(req, origin) &&
    (Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https');
  const handler = async (req, res) => {
    try {
      if (!authorityAccepted(req)) return jsonResponse(res, 403, { error: 'forbidden' });
      const sourceId = trustedClientAddress(req);
      if (!sourceId) return jsonResponse(res, 403, { error: 'untrusted_proxy' });
      if (!requests.allow(sourceId)) return jsonResponse(res, 429, { error: 'rate_limited' });
      await handleHttpApi(req, res, { auth, runtimeGrants, relay, sourceId, notifications });
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 413, 415, 429, 503].includes(error.status) ? error.status : 500;
      const code = status === 500 ? 'internal_error' :
        (/^[a-z_]{1,64}$/.test(error.code ?? '') ? error.code : 'request_failed');
      if (!res.headersSent && !res.destroyed) jsonResponse(res, status, { error: code });
    }
  };
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME,
    perMessageDeflate: false, clientTracking: true });
  const reject = (socket, status = 401) => socket.end(
    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

  const acceptClient = (peer, context, token) => {
    const principal = auth.authenticate(token);
    if (!principal) { close(peer); return; }
    context.role = 'client'; context.token = token; context.sessionId = principal.sessionId;
    const admitted = relay.attachClient(peer, { ...principal,
      allowedRuntimeIds: runtimeGrants.map((grant) => grant.runtimeId) });
    if (admitted === false) { close(peer, 1013, 'Capacity exceeded'); return; }
    send(peer, { type: 'authenticated', sessionId: principal.sessionId, expiresAt: principal.expiresAt,
      capabilities: clientCapabilities() });
  };

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!authorityAccepted(req)) return reject(socket, 403);
    const sourceId = trustedClientAddress(req);
    if (!sourceId) return reject(socket, 403);
    if (peers.size >= MAX_CONNECTIONS || !upgrades.allow(sourceId)) {
      return reject(socket, 429);
    }
    const isRuntime = req.url === '/agent-bridge';
    if (!isRuntime && req.url !== '/v2/realtime') return reject(socket, 404);
    const grant = isRuntime ? resolveRuntimeCredential(req.headers.authorization, runtimeGrants) : null;
    if (isRuntime && !grant) return reject(socket);
    const clientToken = isRuntime ? '' : bearerToken(req);
    if (!isRuntime && !auth.authenticate(clientToken)) return reject(socket);
    wss.handleUpgrade(req, socket, head, (peer) => {
      const context = { role: isRuntime ? 'runtime' : 'client', alive: true };
      peers.set(peer, context);
      peer.on('error', () => peer.terminate());
      peer.on('close', () => { relay.disconnect(peer); peers.delete(peer); });
      peer.on('pong', () => { context.alive = true; });
      if (grant && relay.attachRuntime(peer, grant) === false) close(peer, 1008, 'Runtime unavailable');
      if (!isRuntime) acceptClient(peer, context, clientToken);
      peer.on('message', (data, binary) => {
        if (binary) { close(peer, 1008, 'Text messages required'); return; }
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch { close(peer); return; }
        if (!message || Array.isArray(message) || typeof message !== 'object') { close(peer); return; }
        try {
          if (context.role === 'runtime') { relay.runtimeMessage(peer, message); return; }
          if (!auth.authenticate(context.token)) { close(peer); return; }
          relay.clientMessage(peer, message);
        } catch { close(peer, 1008, 'Invalid message'); }
      });
    });
  });

  const unsubscribe = auth.subscribeRevocations((sessionId) => {
    notifications.revoke(sessionId);
    for (const [peer, context] of peers) if (context.sessionId === sessionId) close(peer);
  });
  const sweep = setInterval(() => {
    auth.prune(); relay.prune(); upgrades.prune(); requests.prune();
    for (const [peer, context] of peers) {
      if (context.role === 'client' && !auth.authenticate(context.token)) close(peer);
    }
  }, 1_000);
  sweep.unref();
  const heartbeat = setInterval(() => {
    for (const [peer, context] of peers) {
      if (!context.alive) { peer.terminate(); continue; }
      context.alive = false;
      if (peer.readyState === WebSocket.OPEN) peer.ping();
    }
  }, 30_000);
  heartbeat.unref();
  notifications.start();
  let stopped = false;
  return {
    listen: (port = 8788) => new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', () => { server.off('error', rejectListen); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => {
      if (stopped) { resolve(); return; }
      stopped = true;
      clearInterval(sweep); clearInterval(heartbeat); unsubscribe();
      for (const peer of peers.keys()) peer.terminate();
      wss.close(); server.closeAllConnections();
      server.close(() => {
        void notifications.close().finally(() => { auth.close(); database.close(); resolve(); });
      });
    }),
  };
}
