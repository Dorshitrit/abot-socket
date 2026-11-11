import { bearerToken, jsonResponse, readJson } from './transport-limits.mjs';
import { clientCapabilities } from '../cli/client-capabilities.mjs';
import { handleNotificationHttp } from '../notifications/notification-http.mjs';

export async function handleHttpApi(req, res, { auth, runtimeGrants, relay, sourceId, notifications }) {
  const path = req.url;
  if (req.method === 'GET' && path === '/health') return jsonResponse(res, 200, { ok: true, version: 2 });
  if (req.method === 'POST' && path === '/v2/pairing/redeem') {
    return jsonResponse(res, 200, auth.redeemPairing(await readJson(req), sourceId));
  }
  const principal = auth.authenticate(bearerToken(req));
  if (!principal) return jsonResponse(res, 401, { error: 'unauthorized' });
  if (notifications && await handleNotificationHttp(req, res, { principal, notifications, runtimeGrants })) return;
  if (req.method === 'GET' && path === '/v2/auth/sessions') {
    return jsonResponse(res, 200, { sessions: auth.listSessions(principal) });
  }
  if (req.method === 'POST' && path === '/v2/auth/logout') {
    auth.revoke(principal, principal.sessionId);
    return jsonResponse(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && /^\/v2\/auth\/sessions\/[A-Za-z0-9_-]{16,128}$/.test(path)) {
    return jsonResponse(res, 200, { revoked: auth.revoke(principal, path.split('/').at(-1)) });
  }
  if (req.method === 'GET' && path === '/v2/runtimes') {
    const snapshots = relay.runtimeSnapshot(runtimeGrants.map((grant) => grant.runtimeId));
    return jsonResponse(res, 200, { runtimes: runtimeGrants.map(({ runtimeId, allowedModes }, index) => ({
      ...snapshots[index], runtimeId, allowedModes, capabilities: clientCapabilities(),
    })) });
  }
  return jsonResponse(res, 404, { error: 'not_found' });
}
