import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay/relay.mjs';

const profile = {
  id: 'primary', label: 'Primary model', providerId: 'local', provider: 'test-provider',
  model: 'test:vision', supportsThinking: true, reasoningControls: { budgetTokens: true },
  capabilities: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
  supportsImageInput: true, executionPolicy: 'execution-agent-v1',
};
const catalog = { schemaVersion: 1, defaultProfileId: 'primary', profiles: [profile] };

function fixture() {
  const closed = [];
  const relay = new Relay({ now: () => 1_000, send: () => true,
    close: (peer, code, reason) => closed.push({ peer, code, reason }),
  });
  const register = (runtimeId, modelCatalog = catalog) => {
    const peer = { runtimeId };
    assert.equal(relay.attachRuntime(peer, { runtimeId, allowedModes: ['ask'] }), true);
    relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, modelCatalog,
      features: ['request_steering_v1'] });
    return peer;
  };
  return { relay, register, closed };
}

test('runtimeSnapshot projects only granted runtime IDs and includes offline state', () => {
  const f = fixture(); f.register('alpha'); f.register('private-runtime');
  const waiting = {};
  assert.equal(f.relay.attachRuntime(waiting, { runtimeId: 'waiting' }), true);
  assert.deepEqual(f.relay.runtimeSnapshot(['alpha', 'offline', 'waiting', 'alpha']), [
    { runtimeId: 'alpha', online: true, modelCatalog: catalog, features: ['request_steering_v1'] },
    { runtimeId: 'offline', online: false, modelCatalog: null, features: [] },
    { runtimeId: 'waiting', online: false, modelCatalog: null, features: [] },
  ]);
  assert.deepEqual(f.relay.runtimeSnapshot([]), []);
  assert.deepEqual(f.relay.runtimeSnapshot(null), []);
  assert.deepEqual(f.relay.runtimeSnapshot(['invalid/path']), []);
});

test('catalog preserves current loader display and capability fields without private configuration', () => {
  const f = fixture(); f.register('alpha', { ...catalog, privateConfig: 'not-projected', profiles: [
    { ...profile, apiKeyEnv: 'TEST_PROVIDER_KEY', baseUrl: 'https://private.invalid',
      plugins: { deny: ['private-policy'] }, reasoningControls: { budgetTokens: true, privateSetting: 'hidden' },
      capabilities: { ...profile.capabilities, privateSetting: 'hidden' } },
  ] });
  const [snapshot] = f.relay.runtimeSnapshot(['alpha']);
  assert.deepEqual(snapshot.modelCatalog, catalog);
  assert.deepEqual(Object.keys(snapshot).sort(), ['features', 'modelCatalog', 'online', 'runtimeId']);
  assert.equal(JSON.stringify(snapshot).includes('TEST_PROVIDER_KEY'), false);
});

test('runtimeSnapshot is a detached view and loses catalog after disconnect', () => {
  const f = fixture(); const peer = f.register('alpha');
  const first = f.relay.runtimeSnapshot(['alpha'])[0];
  first.features.push('injected'); first.modelCatalog.profiles[0].capabilities.inputModalities.push('audio');
  first.modelCatalog.profiles[0].reasoningControls.budgetTokens = false;
  assert.deepEqual(f.relay.runtimeSnapshot(['alpha'])[0].modelCatalog, catalog);
  assert.deepEqual(f.relay.runtimeSnapshot(['alpha'])[0].features, ['request_steering_v1']);
  f.relay.disconnect(peer);
  assert.deepEqual(f.relay.runtimeSnapshot(['alpha']), [
    { runtimeId: 'alpha', online: false, modelCatalog: null, features: [] },
  ]);
});

test('known catalog capability fields reject wrong types instead of silently dropping them', () => {
  const f = fixture(); f.register('alpha', { ...catalog, profiles: [{ ...profile, supportsThinking: 'yes' }] });
  assert.equal(f.closed.at(-1).reason, 'invalid_model_catalog');
  assert.equal(f.relay.runtimeSnapshot(['alpha'])[0].online, false);
});
