import { id, integer, fail } from './protocol-validation.mjs';

const MAX_BYTES = 1024 * 1024;
const MUTATIONS = new Set(['agents.message.send.request', 'agents.action.request', 'agents.approval.decide.request',
  'agents.create.request', 'agents.update.request', 'agents.delete.request', 'agents.schedules.create.request',
  'agents.schedules.update.request', 'agents.schedules.cancel.request']);
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}
function scalar(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string' && value.length <= MAX_BYTES) return value;
  fail();
}
function rows(value, project, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value.map(item => project(item));
}
function fields(value, keys, nested = {}) {
  object(value);
  const result = {};
  for (const key of keys.split(' ')) {
    if (Object.hasOwn(value, key)) result[key] = scalar(value[key]);
  }
  for (const [key, project] of Object.entries(nested)) {
    if (Object.hasOwn(value, key)) result[key] = value[key] === null ? null : project(value[key]);
  }
  return result;
}
function same(actual, expected) { if (actual !== expected) fail(); }
const counts = v => fields(v, 'maxAttempts maxModelCalls maxTotalTokens maxConsecutiveNoProgress maxClarificationRounds');
const binding = v => fields(v, 'agentRevision modelProfileId executionPolicy toolPermissionMode');
const choiceList = v => rows(v, scalar, 8);
const onboarding = v => fields(v, 'role style updates custom notes color budget', { outputs: choiceList, asks: choiceList });
const definition = v => fields(v, 'name icon basePrompt modelProfileId toolPermissionMode executionPolicy', { onboarding, defaultLimits: counts });
const reply = v => fields(v, 'id missionId text createdAt');
function publishedWorkUpdate(value, currentMission) {
  object(value); object(currentMission);
  same(value.missionId, currentMission.id);
  same(currentMission.status, 'active');
  for (const [key, maximum] of [['id', 4096], ['missionId', 128], ['text', 1200], ['createdAt', 64]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > maximum) fail();
  }
  if (!Number.isFinite(Date.parse(value.createdAt))) fail();
  return fields(value, 'id missionId text createdAt');
}
function summary(v) {
  id(v.id);
  return fields(v, 'id name icon modelProfileId toolPermissionMode status workStatus sessionCount isDeleting canSend hasWork thinkingSince', {
    latestReply: reply, mission: m => fields(m, 'id status'), latestWorkUpdate: u => publishedWorkUpdate(u, v.mission),
  });
}
function mission(v, agentId) {
  same(v.agentId, agentId);
  return fields(v, 'id agentId revision objective status waitingReason createdAt updatedAt', { limits: counts,
    usage: u => fields(u, 'attempts modelCalls totalTokens consecutiveNoProgress clarificationRounds'),
    successCriteria: c => rows(c, i => fields(i, 'id description'), MAX_BYTES) });
}
const wait = v => fields(v, 'generation waitId revision');

// Parameters may be inspected as disclosure for the single pending approval. They are never accepted back as a command.
function publicParameters(v, depth = 0) {
  if (depth > 8) fail('agents_response_too_complex');
  if (Array.isArray(v)) {
    if (v.length > 100) fail('agents_response_too_complex');
    return rows(v, item => publicParameters(item, depth + 1));
  }
  if (v === null || typeof v !== 'object') return scalar(v);
  const entries = Object.entries(v);
  if (entries.length > 100 || entries.some(([k]) => k.length > 256)) fail('agents_response_too_complex');
  if (entries.some(([k]) => ['__proto__', 'constructor', 'prototype'].includes(k))) fail('agents_response_too_complex');
  return Object.fromEntries(entries.map(([k, item]) => [k, publicParameters(item, depth + 1)]));
}
function approval(v) {
  return fields(v, 'sessionId', { wait, request: r => fields(r, 'requestId approvalId description summary', {
    call: c => fields(c, 'tool clientStatus', { params: publicParameters }),
  }) });
}
function detail(data, agentId) {
  same(data.agent?.id, agentId);
  const record = fields(data.agent, 'id revision status createdAt updatedAt', { definition });
  object(record.definition);
  return { ...fields(data, 'status activity isDeleting pendingUserQuestionId canSend nextBeforeMessageId hasWork thinkingSince latestVisibleReplyId standaloneConversation planRecoveryStatus latestPlanNoticeId', {
    mission: v => mission(v, agentId), recovery: v => fields(v, 'requiresNewBudget unansweredUpdateId pausedChatBlock recordedWorkDelivery'),
    replyingToMessageIds: v => rows(v, scalar, MAX_BYTES), approvals: v => rows(v, approval, MAX_BYTES),
    updates: v => rows(v, u => fields(u, 'id missionId createdAt text kind')),
    messages: v => rows(v, m => {
      same(m.agentId, agentId);
      return fields(m, 'id agentId missionId role purpose text createdAt inputIntent');
    }),
  }), revision: integer(data.revision), agent: record };
}
function schedule(v, agentId) {
  same(v.agentId, agentId);
  return fields(v, 'id agentId title text startAt intervalMs maxOccurrences revision status nextRunAt', { limits: counts, binding,
    occurrences: a => rows(a, o => fields(o, 'ordinal messageId scheduledAt status reason missionId createdAt', { binding }), 1000) });
}
function sessionMessage(v, sessionId) {
  same(v.sessionId, sessionId);
  return fields(v, 'kind id sessionId role text source createdAt requestId cronJobId cronTitle triggerType', {
    attachments: a => rows(a, item => fields(item, 'id kind mimeType name size'), MAX_BYTES),
    schedule: s => fields(s, 'jobId runId title scheduledAt triggerType'),
    initiative: i => fields(i, 'kind proposalId reason'),
    approvalRequest: a => fields(a, 'kind waitId state', { approvals: items => rows(items,
      item => fields(item, 'approvalId actionFingerprint', { presentation: p => fields(p, 'description summary tool') }), MAX_BYTES) }),
  });
}
function projectData(command, data, agentId) {
  object(data);
  switch (command.type) {
    case 'agents.authoring.preview.request': {
      const preview = object(data.preview);
      if (typeof preview.basePrompt !== 'string' || preview.basePrompt.length > 16_000) fail();
      const budget = v => {
        const result = counts(v);
        for (const key of ['maxAttempts', 'maxModelCalls', 'maxTotalTokens', 'maxConsecutiveNoProgress', 'maxClarificationRounds']) {
          integer(result[key], key === 'maxConsecutiveNoProgress' ? 1 : 0);
        }
        return result;
      };
      const presets = object(preview.presets);
      return { preview: { basePrompt: preview.basePrompt, presets: { short: budget(presets.short),
        standard: budget(presets.standard), deep: budget(presets.deep) }, limits: preview.limits === null ? null : budget(preview.limits) } };
    }
    case 'agents.list.request': return { revision: integer(data.revision), agents: rows(data.agents, summary),
      ...fields(data, 'nextCursor') };
    case 'agents.sessions.request': return { revision: integer(data.revision), sessions: rows(data.sessions, session => {
      same(session.agentId, agentId);
      return fields(session, 'agentId sessionId purpose createdAt status settledAttemptId');
    }), ...fields(data, 'nextCursor') };
    case 'agents.session.request': {
      const v = object(data.session);
      same(v.sessionId, command.sessionId);
      return { session: { ...fields(v, 'sessionId title nextCursor newerCursor'), messages: rows(v.messages, m => sessionMessage(m, command.sessionId)) } };
    }
    case 'agents.schedules.list.request': return { schedules: rows(data.schedules, v => schedule(v, agentId)), ...fields(data, 'nextCursor') };
    case 'agents.schedules.create.request':
    case 'agents.schedules.update.request':
    case 'agents.schedules.cancel.request':
      same(data.schedule?.id, command.scheduleId);
      return { schedule: schedule(data.schedule, agentId) };
    case 'agents.delete.request':
      same(data.deleted, true);
      return { deleted: true };
    default: return detail(data, agentId);
  }
}
function acknowledgement(command, targetAgentId, revision) {
  if (!MUTATIONS.has(command.type)) fail();
  const target = id(targetAgentId);
  if (command.type !== 'agents.create.request') same(target, command.targetAgentId);
  return { acknowledged: true, needsRefetch: true, targetAgentId: target,
    ...(revision !== undefined ? { revision: integer(revision) } : {}) };
}
export function projectAgentResponse(command, body) {
  try {
    if (typeof body.ok !== 'boolean' || Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) return null;
    const result = { type: body.type, correlationId: id(body.correlationId), ok: body.ok };
    for (const field of ['sessionId', 'clientMessageId', 'targetAgentId']) {
      same(body[field], command[field]);
      if (command[field] !== undefined) result[field] = command[field];
    }
    if (body.ok) {
      if (body.data?.acknowledged === true && body.data.needsRefetch === true) {
        result.data = acknowledgement(command, body.data.targetAgentId, body.data.revision);
        return result;
      }
      const target = command.type === 'agents.create.request' ? id(body.data?.agent?.id) : result.targetAgentId;
      try { result.data = projectData(command, body.data, target); }
      catch (error) {
        if (error.code !== 'agents_response_too_complex') throw error;
        if (!MUTATIONS.has(command.type)) return { ...result, ok: false, error: error.code };
        result.data = acknowledgement(command, target, body.data.revision);
      }
    }
    else {
      if (typeof body.error !== 'string' || !/^(?:agents_|agent_|approval_)[a-z0-9_]{1,100}$/.test(body.error)) return null;
      result.error = body.error;
    }
    return result;
  } catch { return null; }
}
