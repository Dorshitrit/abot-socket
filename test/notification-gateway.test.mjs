import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNotificationGateway } from '../src/notifications/notification-gateway.mjs';
import { previewVector, previewKey } from './notification-preview-fixture.mjs';
import { sealNotificationPreview } from '../src/notifications/notification-preview-crypto.mjs';
import { NotificationGatewayStore } from '../src/notifications/notification-gateway-store.mjs';

const token = 'dummy-fcm-device-token-123456789';
const secondToken = 'dummy-other-device-token-123456789';

async function fixture(t, provider) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'abot-gateway-test-')));
  let clock = 1_700_000_000_000;
  const sent = [];
  const options = { stateDirectory: join(directory, 'gateway'), publicOrigin: 'https://push.example.invalid',
    now: () => clock, sendProviderEnvelope: provider ?? (async (target, envelope) => {
      sent.push({ target, envelope }); return { status: 'delivered' };
    }) };
  let gateway = createNotificationGateway(options);
  t.after(async () => { await gateway.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, options, sent, now: () => clock, advance: (ms) => { clock += ms; },
    restart: async () => { await gateway.close(); gateway = createNotificationGateway(options); },
    call: async (path, body, credential, overrides = {}) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method: 'POST', url: path, socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'push.example.invalid', 'x-forwarded-proto': 'https',
          'x-socket-client-ip': '203.0.113.10', 'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...overrides } });
      const result = {};
      const res = { writeHead(status) { result.status = status; }, end(value) { result.body = JSON.parse(value); } };
      await gateway.handler(req, res);
      return result;
    },
  };
}

async function enroll(f, target = token) {
  const response = await f.call('/v1/enroll', { token: target });
  assert.equal(response.status, 200);
  const { abotPushChallenge, proof } = f.sent.at(-1).envelope.data;
  assert.deepEqual(f.sent.at(-1).envelope.android, { priority: 'NORMAL', ttl: '120s' });
  assert.equal(Object.hasOwn(f.sent.at(-1).envelope, 'notification'), false);
  assert.equal(response.body.challengeId, abotPushChallenge);
  assert.equal(Object.hasOwn(response.body, 'proof'), false);
  const confirmed = await f.call('/v1/confirm', { challengeId: abotPushChallenge, proof });
  assert.equal(confirmed.status, 200);
  return { grant: confirmed.body, challengeId: abotPushChallenge, proof };
}

function delivery(grant, now, id = 'n'.repeat(32)) {
  return { endpointId: grant.endpointId, notificationId: id, kind: 'completed', badge: 1, expiresAt: now + 60_000 };
}

test('device proof enrolls a scoped endpoint, generic send is deduplicated across gateway restart', async (t) => {
  const f = await fixture(t);
  const { grant, challengeId, proof } = await enroll(f);
  assert.equal((await f.call('/v1/confirm', { challengeId, proof })).status, 401);
  const input = delivery(grant, f.now());
  assert.equal((await f.call('/v1/deliver', input, grant.sendToken)).status, 200);
  assert.deepEqual(f.sent.at(-1).envelope.data, { notificationId: input.notificationId });
  assert.equal(f.sent.at(-1).target, token);
  assert.equal(f.sent.length, 2);
  await f.restart();
  assert.equal((await f.call('/v1/deliver', input, grant.sendToken)).status, 200);
  assert.equal(f.sent.length, 2, 'same notification is not resent');
});

test('sender cannot choose another target, content, URL, or use its send grant for revocation', async (t) => {
  const f = await fixture(t);
  const first = (await enroll(f)).grant;
  const second = (await enroll(f, secondToken)).grant;
  assert.equal((await f.call('/v1/deliver', delivery(second, f.now()), first.sendToken)).status, 401);
  for (const extra of [{ token: secondToken }, { text: 'arbitrary content' }, { url: 'https://attacker.invalid' }]) {
    assert.equal((await f.call('/v1/deliver', { ...delivery(first, f.now()), ...extra }, first.sendToken)).status, 400);
  }
  assert.equal((await f.call('/v1/revoke', { endpointId: first.endpointId }, first.sendToken)).status, 401);
  assert.equal((await f.call('/v1/revoke', { endpointId: first.endpointId }, first.manageToken)).status, 200);
  assert.equal((await f.call('/v1/deliver', delivery(first, f.now()), first.sendToken)).status, 401);
  assert.equal((await f.call('/v1/deliver', delivery(second, f.now()), second.sendToken)).status, 200);
});

test('enrollment cooldown never revokes an existing endpoint until a new proof succeeds', async (t) => {
  const f = await fixture(t);
  const first = (await enroll(f)).grant;
  assert.equal((await f.call('/v1/enroll', { token })).status, 429);
  f.advance(120_001);
  const pending = await f.call('/v1/enroll', { token });
  assert.equal(pending.status, 200);
  assert.equal((await f.call('/v1/deliver', delivery(first, f.now()), first.sendToken)).status, 200);
  const proof = f.sent.findLast((item) => item.envelope.data.abotPushChallenge)?.envelope.data.proof;
  assert.equal((await f.call('/v1/confirm', { challengeId: pending.body.challengeId, proof })).status, 200);
  assert.equal((await f.call('/v1/deliver', delivery(first, f.now()), first.sendToken)).status, 401);
});

test('proof expiry and bounded wrong guesses prevent issuing an endpoint', async (t) => {
  const f = await fixture(t);
  const pending = await f.call('/v1/enroll', { token });
  const proof = f.sent.at(-1).envelope.data.proof;
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.call('/v1/confirm', { challengeId: pending.body.challengeId, proof: 'x'.repeat(43) })).status, 401);
  }
  assert.equal((await f.call('/v1/confirm', { challengeId: pending.body.challengeId, proof })).status, 401);
  const other = await f.call('/v1/enroll', { token: secondToken });
  const otherProof = f.sent.at(-1).envelope.data.proof;
  f.advance(120_001);
  assert.equal((await f.call('/v1/confirm', { challengeId: other.body.challengeId, proof: otherProof })).status, 401);
});

test('proof and destination capabilities are hashed in private persistent state', async (t) => {
  const f = await fixture(t);
  const { grant } = await enroll(f);
  const store = new NotificationGatewayStore(f.options);
  try {
    const row = store.db.prepare('SELECT * FROM gateway_endpoints').get();
    assert.notEqual(row.send_hash, grant.sendToken);
    assert.notEqual(row.manage_hash, grant.manageToken);
    assert.equal(row.send_hash.length, 64);
    assert.equal(store.authorize(grant.endpointId, grant.sendToken)?.token, token);
  } finally { store.close(); }
  f.advance(30 * 86_400_000 + 1);
  assert.equal((await f.call('/v1/deliver', delivery(grant, f.now()), grant.sendToken)).status, 401);
});

test('only trusted proxy authority and bounded projected fields reach provider', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/v1/enroll', { token }, null, { host: 'other.invalid' })).status, 403);
  assert.equal((await f.call('/v1/enroll', { token }, null, { 'x-forwarded-proto': 'http' })).status, 403);
  assert.equal((await f.call('/v1/enroll', { token }, null, { 'x-socket-client-ip': 'not-an-ip' })).status, 403);
  assert.equal(f.sent.length, 0);
  const { grant } = await enroll(f);
  for (const patch of [{ kind: 'execute' }, { badge: -1 }, { expiresAt: f.now() - 1 },
    { expiresAt: f.now() + 8 * 86_400_000 }]) {
    assert.equal((await f.call('/v1/deliver', { ...delivery(grant, f.now()), ...patch }, grant.sendToken)).status, 400);
  }
  assert.equal(f.sent.length, 1);
});

test('transient provider errors can retry while an invalid destination revokes only its own grant', async (t) => {
  const f = await fixture(t);
  const first = (await enroll(f)).grant;
  const second = (await enroll(f, secondToken)).grant;
  let status = 'retry';
  f.options.sendProviderEnvelope = async () => ({ status });
  await f.restart();
  const input = delivery(first, f.now());
  assert.equal((await f.call('/v1/deliver', input, first.sendToken)).status, 503);
  status = 'delivered';
  assert.equal((await f.call('/v1/deliver', input, first.sendToken)).status, 200);
  status = 'invalid';
  assert.equal((await f.call('/v1/deliver', delivery(first, f.now(), 'm'.repeat(32)), first.sendToken)).status, 410);
  status = 'delivered';
  assert.equal((await f.call('/v1/deliver', input, first.sendToken)).status, 401);
  assert.equal((await f.call('/v1/deliver', delivery(second, f.now()), second.sendToken)).status, 200);
});

test('revoking a grant aborts in-flight delivery without hanging or crossing another device grant', async (t) => {
  const f = await fixture(t);
  const { grant } = await enroll(f);
  let started;
  const sending = new Promise((resolve) => { started = resolve; });
  let providerSignal;
  f.options.sendProviderEnvelope = async (_token, _envelope, signal) => {
    providerSignal = signal;
    started();
    return new Promise(() => {});
  };
  await f.restart();
  const pending = f.call('/v1/deliver', delivery(grant, f.now()), grant.sendToken);
  await sending;
  const revoked = await f.call('/v1/revoke', { endpointId: grant.endpointId }, grant.manageToken);
  assert.equal(revoked.status, 200);
  assert.equal(providerSignal.aborted, true);
  assert.equal((await pending).status, 503);
  assert.equal((await f.call('/v1/deliver', delivery(grant, f.now()), grant.sendToken)).status, 401);
});


test('gateway validates ciphertext only, retains generic delivery, and never persists preview or key material', async t => {
  const f = await fixture(t); const { grant } = await enroll(f);
  const input = delivery(grant, f.now(), previewVector.notificationId);
  const preview = sealNotificationPreview(previewKey.keyId, Buffer.from(previewKey.key, 'base64url'),
    { id: input.notificationId, expiresAt: input.expiresAt }, previewVector.plaintext);
  for (const invalid of [{ ...preview, key: previewKey.key }, { ...preview, plaintext: previewVector.plaintext },
    { ...preview, expiresAt: input.expiresAt + 1 }, { ...preview, nonce: 'bad' }]) {
    assert.equal((await f.call('/v1/deliver', { ...input, preview: invalid }, grant.sendToken)).status, 400);
  }
  assert.equal(f.sent.length, 1);
  assert.equal((await f.call('/v1/deliver', { ...input, preview }, grant.sendToken)).status, 200);
  const encoded = JSON.stringify(f.sent.at(-1).envelope);
  assert.equal(encoded.includes(previewKey.key), false);
  assert.equal(encoded.includes(previewVector.plaintext), false);
  assert.deepEqual(JSON.parse(f.sent.at(-1).envelope.data.abotPreview), preview);
  assert.equal(f.sent.at(-1).envelope.notification, undefined);
  const store = new NotificationGatewayStore(f.options);
  try {
    const persisted = JSON.stringify(store.db.prepare('SELECT * FROM gateway_deliveries').all());
    assert.equal(persisted.includes(preview.ciphertext), false);
    assert.equal(persisted.includes(previewKey.key), false);
  } finally { store.close(); }
  await f.restart();
  assert.equal((await f.call('/v1/deliver', { ...input, preview }, grant.sendToken)).status, 200);
  assert.equal(f.sent.length, 2, 'ciphertext delivery still obeys gateway deduplication');
  assert.equal((await f.call('/v1/deliver', delivery(grant, f.now()), grant.sendToken)).status, 200);
  assert.equal(f.sent.at(-1).envelope.notification.body, 'Your response is ready.');
});
