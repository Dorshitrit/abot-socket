import assert from 'node:assert/strict';
import test from 'node:test';
import { Relay } from '../src/relay/relay.mjs';
import { AGENT_FIELDS, AGENTS_FEATURE } from '../src/protocol/agents-protocol.mjs';
import { normalizeClientCommand, expectedResponseType } from '../src/protocol/protocol.mjs';
import { projectAgentResponse } from '../src/protocol/agents-response.mjs';
import { approvalTransportFixture } from './approval-transport-fixture.mjs';

const target = { targetAgentId: 'research' };
const limits = { maxAttempts: 4, maxModelCalls: 12, maxTotalTokens: 160_000,
  maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 };
const definition = { name: 'Research', icon: 'mint', basePrompt: 'Research the requested subject.',
  modelProfileId: 'model-a', toolPermissionMode: 'ask' };
const edit = { definition, limits, expectedRevision: 0 };
const schedule = { ...target, scheduleId: 'weekly', title: 'Weekly summary', text: 'Review updates.',
  startAt: '2026-11-20T12:00:00.000Z', intervalMs: null, maxOccurrences: 1, limits };
const requests = {
  'agents.subscribe.request': {}, 'agents.unsubscribe.request': {}, 'agents.list.request': { limit: 100, cursor: null },
  'agents.authoring.preview.request': { authoring: {} },
  'agents.detail.request': { ...target, beforeMessageId: null }, 'agents.message.send.request': { ...target, clientMessageId: 'send-1', text: 'שלום' },
  'agents.action.request': { ...target, action: 'steer', text: 'Clarify' },
  'agents.approval.decide.request': { ...target, approvalId: 'approve', approved: true,
    waitId: 'wait', revision: 2, generation: 'gen', commandId: 'decision' },
  'agents.create.request': edit, 'agents.update.request': { ...target, ...edit }, 'agents.delete.request': { ...target, expectedRevision: 0 },
  'agents.sessions.request': { ...target, limit: 10 }, 'agents.session.request': { ...target, sessionId: 'work', limit: 30, cursor: null },
  'agents.schedules.list.request': target, 'agents.schedules.create.request': schedule,
  'agents.schedules.update.request': { ...schedule, expectedRevision: 3 }, 'agents.schedules.cancel.request': { ...target, scheduleId: 'weekly', expectedRevision: 2 },
};
function body(type, extra = {}) { return { type, ...requests[type], ...extra }; }
function fixture() {
  let serial = 0;
  const sent = [], revoked = new Set();
  const relay = new Relay({ close() {}, isClientAuthorized: client => !revoked.has(client.peer),
    send(peer, message) { sent.push({ peer, message }); return true; } });
  function runtime(runtimeId = 'alpha', features = [AGENTS_FEATURE]) {
    const peer = { serial: ++serial };
    assert.ok(relay.attachRuntime(peer, { runtimeId, allowedModes: ['ask'] }));
    relay.runtimeMessage(peer, { type: 'register', agentId: runtimeId, features });
    return peer;
  }
  function client(allowedRuntimeIds = ['alpha', 'beta']) {
    const peer = { serial: ++serial };
    assert.ok(relay.attachClient(peer, { subject: 'owner', sessionId: String(serial), allowedRuntimeIds }));
    return peer;
  }
  function send(peer, value, runtimeId = 'alpha', id = 'c' + ++serial) {
    relay.clientMessage(peer, { id, runtimeId, body: value }); return id;
  }
  const messages = peer => sent.filter(entry => entry.peer === peer).map(entry => entry.message);
  return { relay, runtime, client, send, messages, revoked, last: peer => messages(peer).at(-1) };
}
function detail(agentId = target.targetAgentId) {
  return { revision: 12, agent: { id: agentId, revision: 1, definition, status: 'active' }, status: 'idle',
    messages: [{ id: 'm1', agentId, role: 'assistant', text: 'Done', source: { secret: 'private' } }],
    updates: [], approvals: [{ sessionId: 'work', request: { requestId: 'r', approvalId: 'a',
      call: { tool: 'save', params: { path: 'result.txt' } }, meta: { private: true } },
      wait: { generation: 'gen', waitId: 'w', revision: 2, continuation: 'private' } }],
    recovery: { requiresNewBudget: false }, isDeleting: false, canSend: true, decisions: ['private'], mailbox: ['private'] };
}
test('every Agents request uses explicit client fields and its own expected response type', () => {
  assert.deepEqual(Object.keys(AGENT_FIELDS).sort(), Object.keys(requests).sort());
  for (const type of Object.keys(requests)) {
    assert.deepEqual(normalizeClientCommand(body(type)), body(type), type);
    assert.equal(expectedResponseType(type), type.replace(/request$/, 'response'));
    for (const injected of [{ agentId: 'alpha' }, { correlationId: 'mine' }, { allowedModes: ['full_plus'] }]) {
      assert.throws(() => normalizeClientCommand(body(type, injected)), { code: 'invalid_command' });
    }
  }
  for (const invalid of [
    body('agents.create.request', { definition: { ...definition, executionPolicy: 'super' } }),
    body('agents.create.request', { limits: { ...limits, maxAttempts: -1 } }),
    body('agents.create.request', { limits: { ...limits, maxConsecutiveNoProgress: 0 } }),
    body('agents.detail.request', { limit: 101 }), body('agents.message.send.request', { text: 'a'.repeat(32_001) }),
    body('agents.approval.decide.request', { revision: undefined }),
    body('agents.action.request', { action: 'archive' }), body('agents.schedules.create.request', { maxOccurrences: 2 }),
  ]) assert.throws(() => normalizeClientCommand(invalid), { code: 'invalid_command' });
  const configure = body('agents.create.request', { definition: { ...definition, toolPermissionMode: 'full_plus' } });
  assert.throws(() => normalizeClientCommand(configure, ['ask', 'full_plus']), { code: 'forbidden' });
  assert.deepEqual(normalizeClientCommand(configure, ['ask', 'full_access', 'full_plus']), configure);
});

test('onboarding preview accepts draft choices; committing binds the model, validates choices and retains the separate legacy form', () => {
  const choices = { role: 'research', outputs: ['comparisons'], style: 'balanced', asks: ['unclear'], updates: 'needed',
    custom: '', notes: 'הסבר קצר', color: 'mint', budget: 'deep' };
  const input = { name: 'Research', icon: 'mint', modelProfileId: 'gemma', toolPermissionMode: 'ask', onboarding: choices };
  const preview = { type: 'agents.authoring.preview.request', authoring: { name: '', onboarding: { role: '', budget: '', outputs: [] } } };
  assert.deepEqual(normalizeClientCommand(preview), preview);
  for (const type of ['agents.create.request', 'agents.update.request']) {
    const write = { type, ...(type === 'agents.update.request' ? target : {}), authoring: input, expectedRevision: 1 };
    assert.deepEqual(normalizeClientCommand(write), write);
    assert.deepEqual(normalizeClientCommand(body(type)), body(type));
    for (const edit of [{ ...write, definition }, { ...write, limits }, { ...write, onboarding: choices },
      { ...write, authoring: { ...input, basePrompt: 'override' } }, { ...write, authoring: preview.authoring },
      { ...write, authoring: { ...input, limits } }, { ...write, authoring: { ...input, onboarding: { ...choices, budget: 'custom' } } }]) {
      assert.throws(() => normalizeClientCommand(edit), { code: 'invalid_command' });
    }
    const custom = { ...write, authoring: { ...input, limits, onboarding: { ...choices, budget: 'custom' } } };
    assert.deepEqual(normalizeClientCommand(custom), custom);
  }
  const elevate = { ...preview, authoring: { toolPermissionMode: 'full_access' } };
  assert.throws(() => normalizeClientCommand(elevate), { code: 'forbidden' });
  assert.throws(() => normalizeClientCommand({ ...preview, authoring: { allowedModes: ['full_access'] } }), { code: 'invalid_command' });
  const op = { ...preview, ...target };
  const raw = { type: 'agents.authoring.preview.response', correlationId: 'rpc', ok: true, ...target,
    data: { preview: { basePrompt: 'Check prices', presets: { short: limits, standard: limits, deep: { ...limits, private: 'hidden' } },
      limits: null, private: 'hidden' }, private: 'hidden' } };
  const result = projectAgentResponse(op, raw);
  assert.deepEqual(result.data.preview.presets, { short: limits, standard: limits, deep: limits });
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(projectAgentResponse(op, { ...raw, targetAgentId: 'another' }), null);
  assert.equal(projectAgentResponse(op, { ...raw, data: { acknowledged: true, needsRefetch: true, ...target } }), null);
});

test('relay injects the registered machine grant and scopes message identity and retries to the correct agent', () => {
  const f = fixture(), runtime = f.runtime(), beta = f.runtime('beta'), client = f.client();
  const input = body('agents.message.send.request');
  const id = f.send(client, input), query = f.last(runtime);
  assert.deepEqual(query, { ...input, correlationId: query.correlationId, allowedModes: ['ask'] });
  assert.notEqual(query.correlationId, id);
  f.send(client, input, 'alpha', id);
  assert.equal(f.last(client).code, 'duplicate_command');
  const reply = { type: 'agents.message.send.response', correlationId: query.correlationId, ...target,
    clientMessageId: input.clientMessageId, ok: true, data: detail() };
  f.relay.runtimeMessage(beta, reply);
  f.relay.runtimeMessage(runtime, { ...reply, targetAgentId: 'other' });
  f.relay.runtimeMessage(runtime, { ...reply, clientMessageId: 'other' });
  f.relay.runtimeMessage(runtime, { ...reply, data: detail('other') });
  f.relay.runtimeMessage(runtime, { ...reply, data: { ...detail(), messages: [{ agentId: 'other', text: 'private' }] } });
  assert.equal(f.messages(client).length, 1);
  f.relay.runtimeMessage(runtime, reply);
  const result = f.last(client);
  assert.equal(result.id, id);
  assert.equal(result.body.data.messages[0].text, 'Done');
  assert.equal(result.body.data.approvals[0].request.call.params.path, 'result.txt');
  assert.equal(JSON.stringify(result).includes('private'), false);
  f.relay.runtimeMessage(runtime, reply);
  assert.equal(f.messages(client).length, 2);
  assert.equal(f.messages(runtime).filter(m => m.type === input.type).length, 1);
});

test('rejects unauthorized or unsupported workspaces before transmission', () => {
  const f = fixture(), alpha = f.runtime('alpha', []), beta = f.runtime('beta'), client = f.client(['alpha']);
  for (const type of Object.keys(requests)) {
    f.send(client, body(type), 'alpha');
    assert.equal(f.last(client).code, 'agents_unsupported');
    f.send(client, body(type), 'beta');
    assert.equal(f.last(client).code, 'runtime_forbidden');
  }
  assert.equal(f.messages(alpha).length, 1); assert.equal(f.messages(beta).length, 1);
});

test('subscription belongs to current client and runtime peers; events are content-free invalidation hints', () => {
  const f = fixture(), a = f.runtime(), b = f.runtime('beta'), c = f.client(), observer = f.client();
  const emit = runtime => f.relay.runtimeMessage(runtime, { type: 'agents.changed', revision: 7, internal: 'private' });
  f.send(c, body('agents.subscribe.request'));
  assert.equal(f.last(c).body.data.subscribed, true);
  emit(b); emit(a); emit(a);
  assert.equal(f.messages(c).length, 3);
  assert.deepEqual(f.last(c), { type: 'relay.event', runtimeId: 'alpha', body: { type: 'agents.changed', revision: 7 } });
  assert.equal(f.messages(observer).length, 0);
  f.revoked.add(c); emit(a); f.revoked.delete(c);
  assert.equal(f.messages(c).length, 3);
  f.send(c, body('agents.unsubscribe.request')); emit(a);
  assert.equal(f.last(c).body.data.subscribed, false);
  f.send(c, body('agents.subscribe.request'));
  f.relay.disconnect(c); const another = f.client();
  emit(a); assert.equal(f.messages(another).length, 0);
  f.send(another, body('agents.subscribe.request'));
  const revoked = f.client(), betaOnly = f.client(['beta']);
  f.send(revoked, body('agents.subscribe.request'));
  f.revoked.add(revoked);
  f.send(betaOnly, body('agents.subscribe.request'), 'beta');
  const offline = { type: 'relay.event', runtimeId: 'alpha',
    body: { type: 'agents.subscription.invalidated', reason: 'runtime_disconnected' } };
  f.relay.disconnect(a); f.relay.disconnect(a);
  assert.deepEqual(f.last(another), offline);
  assert.equal(f.messages(another).length, 2);
  assert.equal(f.messages(revoked).length, 1);
  assert.equal(f.messages(betaOnly).length, 1);
  assert.equal(f.messages(observer).length, 0);
  f.send(another, body('agents.subscribe.request'));
  assert.equal(f.last(another).code, 'runtime_offline');
  const replacement = f.runtime();
  emit(a); emit(replacement);
  assert.equal(f.messages(another).length, 3);
  f.send(another, body('agents.subscribe.request')); emit(replacement);
  assert.deepEqual(f.last(another).body, { type: 'agents.changed', revision: 7 });
});

test('late responses after runtime replacement cannot consume a pending operation even on the same machine ID', () => {
  const f = fixture(), old = f.runtime(), c = f.client();
  const command = body('agents.list.request');
  f.send(c, command); f.relay.disconnect(old);
  assert.equal(f.last(c).code, 'outcome_unknown');
  const fresh = f.runtime(); f.send(c, command);
  const reply = { type: 'agents.list.response', correlationId: f.last(fresh).correlationId, ok: true,
    data: { revision: 4, agents: [], nextCursor: null } };
  f.relay.runtimeMessage(old, reply);
  assert.equal(f.messages(c).length, 1);
  f.relay.runtimeMessage(fresh, reply);
  assert.equal(f.last(c).body.data.revision, 4);
});

test('projections bind session, schedules and creation; only named fields and bounded public data leave the relay', () => {
  function project(type, data, extra = {}) {
    const input = body(type);
    return projectAgentResponse(input, { type: expectedResponseType(type), correlationId: 'rpc', ok: true,
      ...(input.targetAgentId ? target : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), data, ...extra });
  }
  const session = { sessionId: 'work', messages: [{ sessionId: 'work', text: 'result', attachments: [
    { id: 'doc', storageRef: 'private/path', name: 'notes' }] }], requests: ['private'] };
  const ok = project('agents.session.request', { session });
  assert.equal(ok.data.session.messages[0].text, 'result');
  assert.equal(JSON.stringify(ok).includes('private'), false);
  assert.equal(project('agents.session.request', { session: { ...session, sessionId: 'foreign' } }), null);
  assert.equal(project('agents.session.request', { session: { ...session, messages: [{ sessionId: 'foreign' }] } }), null);
  assert.equal(project('agents.sessions.request', { revision: 0, sessions: [{ agentId: 'other' }] }), null);
  assert.equal(project('agents.schedules.list.request', { schedules: [{ id: 'weekly', agentId: 'other' }] }), null);
  assert.equal(project('agents.schedules.cancel.request', { schedule: { id: 'wrong', agentId: 'research' } }), null);
  assert.deepEqual(project('agents.schedules.cancel.request', { schedule: { id: 'weekly', agentId: 'research' } }).data.schedule,
    { id: 'weekly', agentId: 'research' });
  assert.equal(project('agents.create.request', detail('new')).data.agent.id, 'new');
  assert.equal(project('agents.list.request', { revision: 0, agents: Array(101).fill({ id: 'one' }) }), null);
  assert.equal(project('agents.list.request', { revision: 0, agents: [], private: 'x'.repeat(1024 * 1024) }), null);
  assert.equal(project('agents.delete.request', null, { ok: false, error: 'private raw error' }), null);
  assert.deepEqual(project('agents.delete.request', null, { ok: false, error: 'agents_agent_busy' }), {
    type: 'agents.delete.response', correlationId: 'rpc', ok: false, ...target, error: 'agents_agent_busy' });
});

test('a committed mutation receipt is bound to its target and requests a fresh view', () => {
  const receipt = { acknowledged: true, needsRefetch: true, ...target, revision: 4 };
  function project(type, data) {
    const command = body(type);
    return projectAgentResponse(command, { type: expectedResponseType(type), correlationId: 'rpc', ok: true,
      ...(command.targetAgentId ? target : {}), ...(command.clientMessageId ? { clientMessageId: command.clientMessageId } : {}), data });
  }
  for (const type of ['agents.create.request', 'agents.update.request', 'agents.message.send.request', 'agents.action.request',
    'agents.approval.decide.request', 'agents.schedules.create.request', 'agents.schedules.cancel.request']) {
    assert.deepEqual(project(type, { ...receipt, private: 'internal' }).data, receipt);
  }
  assert.equal(project('agents.detail.request', receipt), null);
  assert.equal(project('agents.message.send.request', { ...receipt, targetAgentId: 'other' }), null);
  assert.equal(project('agents.create.request', { ...receipt, revision: -1 }), null);
  const view = { ...detail(), hasWork: true, thinkingSince: null, standaloneConversation: false,
    latestVisibleReplyId: 'm1', planRecoveryStatus: 'work_returned', latestPlanNoticeId: null };
  const state = project('agents.detail.request', view).data;
  for (const key of ['hasWork', 'thinkingSince', 'standaloneConversation', 'latestVisibleReplyId', 'planRecoveryStatus', 'latestPlanNoticeId']) {
    assert.equal(state[key], view[key]);
  }
  const page = project('agents.sessions.request', { revision: 3, sessions: [{ agentId: 'research', sessionId: 'work',
    status: 'completed', settledAttemptId: 'attempt-3', assignment: 'secret' }] });
  assert.deepEqual(page.data.sessions, [{ agentId: 'research', sessionId: 'work', status: 'completed', settledAttemptId: 'attempt-3' }]);
  view.messages[0].text = 'א'.repeat(270_000);
  assert.equal(project('agents.message.send.request', view).data.messages[0].text.length, 270_000);
  view.approvals[0].request.call.params.items = Array(101).fill('file');
  assert.deepEqual(project('agents.message.send.request', view).data, { ...receipt, revision: 12 });
  assert.equal(project('agents.detail.request', view).error, 'agents_response_too_complex');
  assert.doesNotThrow(() => normalizeClientCommand(body('agents.message.send.request', { text: '🌳'.repeat(16_000) })));
  assert.doesNotThrow(() => normalizeClientCommand(body('agents.create.request', {
    definition: { ...definition, basePrompt: 'מ'.repeat(16_000) } })));
});

test('a paired device discovers individual capabilities and reads the Agent workspace through authenticated WebSocket', async t => {
  const f = await approvalTransportFixture(t);
  const login = await f.pair(), client = await f.client(login.token);
  assert.equal(client.authenticated.capabilities.agents, true);
  const alpha = await f.runtime('alpha', [AGENTS_FEATURE]);
  await f.runtime('beta', []);
  const catalog = await f.request('/v2/runtimes', { token: login.token });
  assert.deepEqual(catalog.body.runtimes.map(r => [r.runtimeId, r.capabilities.agents]), [['alpha', true], ['beta', false]]);
  const sub = f.command(client, body('agents.subscribe.request'));
  assert.equal((await client.next(m => m.id === sub)).body.data.subscribed, true);
  const id = f.command(client, body('agents.list.request'));
  const query = await alpha.next(m => m.type === 'agents.list.request');
  assert.deepEqual(query.allowedModes, ['ask']);
  alpha.send({ type: 'agents.list.response', correlationId: query.correlationId, ok: true,
    data: { revision: 3, agents: [{ id: 'research', name: 'Research', private: 'secret' }], nextCursor: null, traces: ['secret'] } });
  assert.deepEqual((await client.next(m => m.id === id)).body.data, {
    revision: 3, agents: [{ id: 'research', name: 'Research' }], nextCursor: null });
  alpha.send({ type: 'agents.changed', revision: 5, private: true });
  assert.deepEqual((await client.next(m => m.type === 'relay.event')).body, { type: 'agents.changed', revision: 5 });
  alpha.socket.close();
  await alpha.closed;
  const lost = await client.next(m => m.type === 'relay.event');
  assert.deepEqual(lost, { type: 'relay.event', runtimeId: 'alpha',
    body: { type: 'agents.subscription.invalidated', reason: 'runtime_disconnected' } });
  const replacement = await f.runtime('alpha', [AGENTS_FEATURE]);
  const again = f.command(client, body('agents.subscribe.request'));
  assert.equal((await client.next(m => m.id === again)).body.data.subscribed, true);
  replacement.send({ type: 'agents.changed', revision: 5 });
  assert.deepEqual((await client.next(m => m.type === 'relay.event')).body, { type: 'agents.changed', revision: 5 });
});


test('catalog carries a bound public work update with minimal mission identity and excludes private fields', () => {
  const command = { type: 'agents.list.request' };
  const update = { id: '["agent-update","mission","admission"]', missionId: 'mission',
    text: 'I am checking the source.', createdAt: '2026-11-18T15:26:44.000Z', privateReason: 'PRIVATE' };
  const agent = { id: 'research', name: 'Research', workStatus: 'working', thinkingSince: null,
    mission: { id: 'mission', status: 'active', objective: 'PRIVATE ASSIGNMENT' }, latestWorkUpdate: update,
    latestReply: { id: 'reply', missionId: 'previous', text: 'Previous reply', createdAt: update.createdAt } };
  const response = entries => projectAgentResponse(command, { type: 'agents.list.response', correlationId: 'rpc', ok: true,
    data: { revision: 7, agents: entries, nextCursor: null } });
  const projected = response([agent]);
  assert.deepEqual(projected.data.agents[0].mission, { id: 'mission', status: 'active' });
  assert.deepEqual(projected.data.agents[0].latestWorkUpdate, { id: update.id, missionId: update.missionId,
    text: update.text, createdAt: update.createdAt });
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
  assert.equal(projected.data.agents[0].latestReply.text, 'Previous reply');
  assert.equal(projected.data.agents[0].latestReply.missionId, 'previous');
  assert.equal(response([{ ...agent, latestWorkUpdate: null }]).data.agents[0].latestWorkUpdate, null);
  for (const patch of [{ missionId: 'foreign' }, { text: 'x'.repeat(1201) }, { createdAt: 'invalid' }]) {
    assert.equal(response([{ ...agent, latestWorkUpdate: { ...update, ...patch } }]), null);
  }
  assert.equal(response([{ ...agent, mission: { id: 'mission', status: 'completed' } }]), null);
  assert.equal(response([{ ...agent, mission: null }]), null);
  assert.deepEqual(response([{ id: 'legacy' }]).data.agents, [{ id: 'legacy' }]);
});
