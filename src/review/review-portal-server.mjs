import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AuthService } from '../auth/auth.mjs';
import { sameAuthority, trustedClientAddress } from '../transport/transport-limits.mjs';
import { ReviewPortalAccess } from './review-portal-access.mjs';
import { readReviewPairingForm } from './review-portal-form.mjs';
import { renderReviewPage } from './review-portal-page.mjs';
import { loadReviewDemoConfiguration } from './review-demo-isolation.mjs';

function requirePortalOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Canonical HTTPS origin required');
  return url;
}

function acceptsPortalTransport(req, origin) {
  if (!sameAuthority(req, origin)) return false;
  return req.headers['x-forwarded-proto'] === 'https';
}

function acceptsPairingSubmissionOrigin(req, origin) {
  if (req.headers.origin !== origin.origin) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

function sendPortalPage(res, status, details, headers = {}) {
  const nonce = randomBytes(18).toString('base64url');
  const page = renderReviewPage({ ...details, nonce });
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page),
    'cache-control': 'no-store, private', pragma: 'no-cache',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow, noarchive',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()', ...headers,
  });
  res.end(page);
}

/** Internal constructor; the CLI must load and verify a fresh demo installation first. */
export function createReviewPortalServer({ publicOrigin, socketOrigin, username, passwordSha256,
  stateDirectory, now = Date.now }) {
  const origin = requirePortalOrigin(publicOrigin);
  requirePortalOrigin(socketOrigin);
  if (publicOrigin === socketOrigin) throw new Error('A distinct review origin is required');
  const access = new ReviewPortalAccess({ username, passwordSha256, now });
  const auth = new AuthService({ stateDirectory, now });
  const send = (res, status, details = {}, headers) => sendPortalPage(res, status,
    { socketOrigin, csrf: '', ...details }, headers);
  const server = createServer(async (req, res) => {
    try {
      if (!acceptsPortalTransport(req, origin)) return send(res, 403, { error: 'Request not allowed.' });
      const source = trustedClientAddress(req);
      if (!source) return send(res, 403, { error: 'Request not allowed.' });
      if (!['/review', '/review/pair'].includes(req.url)) return send(res, 404, { error: 'Page not found.' });
      const status = access.authenticate(req.headers.authorization, source);
      if (status === 401) return send(res, 401, { error: 'Use the review access details supplied by the developer.' },
        { 'www-authenticate': 'Basic realm="ABot review workspace", charset="UTF-8"' });
      if (status === 429) return send(res, 429, { error: 'Too many attempts. Try again later.' }, { 'retry-after': '900' });
      if (req.method === 'GET' && req.url === '/review') return send(res, 200, { csrf: access.createCsrf() });
      if (req.method !== 'POST' || req.url !== '/review/pair') {
        return send(res, 405, { error: 'Method not allowed.' });
      }
      if (!acceptsPairingSubmissionOrigin(req, origin)) return send(res, 403, { error: 'Open the review page to continue.' });
      const csrf = await readReviewPairingForm(req);
      if (!access.acceptsCsrf(csrf)) return send(res, 403, { error: 'Reload the review page and try again.' });
      if (!access.allowPairing(source)) {
        return send(res, 429, { error: 'Please wait a minute before generating more pairing details.' }, { 'retry-after': '60' });
      }
      const pairing = { serverUrl: socketOrigin, ...auth.createPairing() };
      return send(res, 200, { csrf: access.createCsrf(), pairing });
    } catch (error) {
      const status = [400, 413, 415].includes(error.status) ? error.status : 500;
      if (!res.headersSent && !res.destroyed) send(res, status, { error: 'Unable to process this request. Reload the review page or contact the developer.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  let stopped = false;
  return {
    listen: (port = 8789) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      if (stopped) { resolve(); return; }
      stopped = true;
      server.closeAllConnections();
      server.close(() => { auth.close(); resolve(); });
    }),
  };
}

export async function startConfiguredReviewPortal(env = process.env) {
  const config = loadReviewDemoConfiguration(env);
  const portal = createReviewPortalServer(config);
  try { await portal.listen(config.port); }
  catch (error) { await portal.close(); throw error; }
  return portal;
}
