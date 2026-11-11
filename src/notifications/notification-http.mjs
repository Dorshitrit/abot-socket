import { jsonResponse, readJson } from '../transport/transport-limits.mjs';
import { notificationListOptions, notificationPresence, notificationReadIds, notificationRegistration, notificationPreviewKey } from './notification-input.mjs';

/** Authenticated device identity comes from the caller, never from request fields. */
export async function handleNotificationHttp(req, res, { principal, notifications, runtimeGrants }) {
  const url = new URL(req.url, 'https://socket.invalid');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/v2/notifications') {
    jsonResponse(res, 200, notifications.list(principal.sessionId, notificationListOptions(url.searchParams)));
    return true;
  }
  if (url.search) return false;
  if (req.method === 'POST' && path === '/v2/notifications/read') {
    notifications.markRead(principal.sessionId, notificationReadIds(await readJson(req)));
    jsonResponse(res, 200, { ok: true }); return true;
  }
  if (req.method === 'POST' && path === '/v2/notifications/presence') {
    const value = notificationPresence(await readJson(req), runtimeGrants.map(grant => grant.runtimeId));
    notifications.updatePresence(principal.sessionId, value);
    jsonResponse(res, 200, { ok: true }); return true;
  }
  if (req.method === 'PUT' && path === '/v2/notifications/push/preview') {
    notifications.enablePreview(principal.sessionId, notificationPreviewKey(await readJson(req, 512)));
    jsonResponse(res, 200, { ok: true }); return true;
  }
  if (req.method === 'DELETE' && path === '/v2/notifications/push/preview') {
    notifications.disablePreview(principal.sessionId);
    jsonResponse(res, 200, { ok: true }); return true;
  }
  if (req.method === 'PUT' && path === '/v2/notifications/push') {
    notifications.register(principal.sessionId, notificationRegistration(await readJson(req, 8192)));
    jsonResponse(res, 200, { ok: true }); return true;
  }
  if (req.method === 'DELETE' && path === '/v2/notifications/push') {
    notifications.unregister(principal.sessionId);
    jsonResponse(res, 200, { ok: true }); return true;
  }
  return false;
}
