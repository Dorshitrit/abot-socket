import qrcode from 'qrcode-generator';
import { pairingQrPayload } from '../pairing/pairing-qr-payload.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const STYLES = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;background:#0b0b0b;color:#eee}
*{box-sizing:border-box}body{margin:0}main{max-width:860px;margin:auto;padding:32px 24px 56px}
header{display:flex;align-items:center;gap:12px;margin-bottom:52px;font-size:14px;color:#aaa}
.brand{font-size:25px;font-weight:800;letter-spacing:-3px;color:#baf4e0;padding-right:4px}
h1{font-size:clamp(30px,5vw,42px);letter-spacing:-1px;line-height:1.15;margin:0 0 16px}
p,li{line-height:1.65;color:#bbb}p{max-width:65ch}h2{font-size:18px;margin:0 0 14px}
.panel{margin-top:28px;padding:24px;border:1px solid #303030;border-radius:18px;background:#141414}
.pairing{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);align-items:start;gap:28px}
.qr{background:white;color:black;padding:10px;border-radius:12px}.qr svg{display:block;width:100%;height:auto}
dl{margin:0}dt{font-size:12px;color:#aaa;margin-top:18px}dt:first-child{margin-top:0}
dd{margin:5px 0 0;font:14px ui-monospace,monospace;overflow-wrap:anywhere;user-select:all}
#pairing-code{font-size:28px;letter-spacing:5px}button{font:inherit;font-weight:600;border:0;border-radius:12px;
padding:14px 20px;background:#baf4e0;color:#10251e;cursor:pointer;margin-top:18px}
button:focus-visible,a:focus-visible{outline:3px solid #8fbaef;outline-offset:4px}a{color:#baf4e0}
.note{font-size:14px;color:#aaa}.error{color:#ffb9ad}.expiry{font-size:13px;color:#ccc}
footer{margin-top:40px;border-top:1px solid #303030;padding-top:20px;color:#888;font-size:13px}
@media(max-width:560px){main{padding:24px 18px}.pairing{grid-template-columns:1fr}.qr{max-width:280px;margin:auto}}
@media(prefers-color-scheme:light){:root{background:#f7f7f7;color:#161616}.panel{background:white;border-color:#ddd}
p,li{color:#505050}header,.note,dt,footer{color:#666}.brand,a{color:#13664c}.expiry{color:#555}.error{color:#9f2618}}
`;

function renderPairingDetails(pairing) {
  if (!pairing) return '';
  const qr = qrcode(0, 'M');
  qr.addData(pairingQrPayload(pairing), 'Byte');
  qr.make();
  return `<section class="panel" aria-labelledby="pairing-title">
<h2 id="pairing-title">Your temporary pairing details</h2>
<div class="pairing"><div class="qr" role="img" aria-label="ABot pairing QR code">
${qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })}</div><dl>
<dt>One-time code</dt><dd id="pairing-code">${escapeHtml(pairing.code)}</dd>
<dt>Server URL</dt><dd id="pairing-server-url">${escapeHtml(pairing.serverUrl)}</dd>
<dt>Temporary pairing key</dt><dd id="pairing-id">${escapeHtml(pairing.pairingId)}</dd>
</dl></div><p class="expiry">Use once before ${escapeHtml(new Date(pairing.expiresAt).toUTCString())}.
After five minutes, generate new details.</p><span id="pairing-expires-at" hidden>${pairing.expiresAt}</span></section>`;
}

export function renderReviewPage({ socketOrigin, csrf, nonce, pairing, error }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ABot — Review workspace</title>
<style nonce="${escapeHtml(nonce)}">${STYLES}</style></head><body><main>
<header><span class="brand" aria-label="ABot">AB</span><span>Review workspace</span></header>
<h1>Pair your app.<br>Explore ABot.</h1>
<p>This access page connects the regular ABot app to a dedicated demonstration workspace.
Only use demonstration data in this environment.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
${renderPairingDetails(pairing)}
<section class="panel"><h2>${pairing ? 'Need another pairing?' : 'Get started'}</h2>
<ol><li>Open ABot and unlock it with your device authentication.</li>
<li>Choose <strong>Scan pairing code</strong> and scan the QR from another screen.
On one device, choose <strong>Enter details manually</strong> and use the code, server URL and key above.</li>
<li>Confirm <strong>${escapeHtml(socketOrigin)}</strong>, then choose the review computer.</li></ol>
${csrf ? `<form method="post" action="/review/pair"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">${pairing ? 'Generate new pairing details' : 'Generate pairing details'}</button></form>`
    : '<p><a href="/review">Return to the review page</a> to continue.</p>'}
<p class="note">Generating new details replaces any unused QR. Already paired devices stay connected.
Keep the details private. This page never needs your device passcode.</p></section>
<footer>If the review computer is offline or a feature is unavailable, contact the developer using
the contact details in App Store Connect. This page does not confirm runtime or model availability.</footer>
</main></body></html>`;
}
