import { approvalId, boolean, fail, id, integer, record } from './protocol-validation.mjs';

export const AGENTS_FEATURE = 'agents_v1';
const page = ['limit', 'cursor'];
const definitionFields = ['definition', 'limits', 'onboarding', 'expectedRevision', 'authoring'];
const scheduleFields = ['targetAgentId', 'scheduleId', 'title', 'text', 'startAt', 'intervalMs', 'maxOccurrences', 'limits'];
export const AGENT_FIELDS = Object.freeze({
  'agents.subscribe.request': [], 'agents.unsubscribe.request': [],
  'agents.list.request': page,
  'agents.authoring.preview.request': ['authoring', 'targetAgentId'],
  'agents.detail.request': ['targetAgentId', 'limit', 'beforeMessageId'],
  'agents.message.send.request': ['targetAgentId', 'clientMessageId', 'text', 'intent', 'limits'],
  'agents.action.request': ['targetAgentId', 'action', 'text', 'limits', 'expectedRevision'],
  'agents.approval.decide.request': ['targetAgentId', 'approvalId', 'approved', 'reason', 'generation', 'waitId', 'revision', 'commandId'],
  'agents.create.request': definitionFields,
  'agents.update.request': ['targetAgentId', ...definitionFields],
  'agents.delete.request': ['targetAgentId', 'expectedRevision'],
  'agents.sessions.request': ['targetAgentId', ...page],
  'agents.session.request': ['targetAgentId', 'sessionId', ...page],
  'agents.schedules.list.request': ['targetAgentId', ...page],
  'agents.schedules.create.request': scheduleFields,
  'agents.schedules.update.request': [...scheduleFields, 'expectedRevision'],
  'agents.schedules.cancel.request': ['targetAgentId', 'scheduleId', 'expectedRevision'],
});
export const AGENT_RESPONSES = Object.freeze(Object.fromEntries(
  Object.keys(AGENT_FIELDS).map(type => [type, type.replace(/\.request$/, '.response')])));
export const isAgentCommand = type => Object.hasOwn(AGENT_FIELDS, type);
export const supportsAgents = runtime => runtime === undefined ||
  (runtime.online === true && runtime.features?.includes(AGENTS_FEATURE) === true);

function text(value, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) fail();
  return value;
}
function choice(value, values) {
  if (!values.includes(value)) fail();
  return value;
}
function selections(value, values, limit) {
  if (!Array.isArray(value) || value.length > limit || new Set(value).size !== value.length) fail();
  return value.map(item => choice(item, values));
}
const limitKeys = ['maxAttempts', 'maxModelCalls', 'maxTotalTokens', 'maxConsecutiveNoProgress', 'maxClarificationRounds'];
function limits(value) {
  record(value, limitKeys);
  return Object.fromEntries(limitKeys.map(key => [key, integer(value[key], key === 'maxConsecutiveNoProgress' ? 1 : 0)]));
}
const onboardingInputs = {
  role: v => choice(v, ['research', 'writing', 'coding', 'planning', 'everyday', 'custom']),
  outputs: v => selections(v, ['recommendations', 'summaries', 'comparisons', 'drafts', 'plans', 'code'], 2),
  style: v => choice(v, ['concise', 'balanced', 'detailed']),
  asks: v => selections(v, ['unclear', 'tradeoffs', 'direction'], 3),
  updates: v => choice(v, ['needed', 'milestones', 'brief']),
  custom: v => text(v, 2000, true), notes: v => text(v, 2000, true),
  color: v => choice(v, ['blue', 'sand', 'mint', 'lilac', 'ivory']),
  budget: v => choice(v, ['short', 'standard', 'deep', 'custom']),
};
function onboarding(value, preview = false) {
  record(value, Object.keys(onboardingInputs));
  const result = {};
  for (const [key, validate] of Object.entries(onboardingInputs)) {
    if (preview && !Object.hasOwn(value, key)) continue;
    result[key] = preview && ['role', 'budget'].includes(key) && value[key] === '' ? '' : validate(value[key]);
  }
  return result;
}
function permissionMode(value, allowed) {
  const modes = ['ask', 'full_access', 'full_plus'];
  const mode = choice(value, modes);
  if (!modes.slice(0, modes.indexOf(mode) + 1).every(required => allowed.includes(required))) fail('forbidden');
  return mode;
}
function definition(value, allowedModes) {
  record(value, ['name', 'icon', 'basePrompt', 'modelProfileId', 'toolPermissionMode']);
  return { name: text(value.name, 80), icon: text(value.icon, 80), basePrompt: text(value.basePrompt, 16_000),
    modelProfileId: text(value.modelProfileId, 256), toolPermissionMode: permissionMode(value.toolPermissionMode, allowedModes) };
}
function authoring(value, allowedModes, preview) {
  record(value, ['name', 'icon', 'modelProfileId', 'toolPermissionMode', 'onboarding', 'limits']);
  const result = {};
  for (const [key, max] of [['name', 80], ['icon', 80], ['modelProfileId', 256]]) {
    if (!preview || Object.hasOwn(value, key)) result[key] = text(value[key], max, preview);
  }
  if (!preview || Object.hasOwn(value, 'toolPermissionMode')) result.toolPermissionMode = permissionMode(value.toolPermissionMode, allowedModes);
  if (!preview || Object.hasOwn(value, 'onboarding')) result.onboarding = onboarding(value.onboarding, preview);
  const budget = result.onboarding?.budget;
  if (Object.hasOwn(value, 'limits')) {
    if (budget !== 'custom') fail();
    result.limits = limits(value.limits);
    for (const key of ['maxAttempts', 'maxModelCalls', 'maxTotalTokens']) if (result.limits[key] < 1) fail();
  }
  if (!preview && (!result.onboarding.outputs.length || (result.onboarding.role === 'custom' && !result.onboarding.custom.trim())
    || (budget === 'custom' && !result.limits))) fail();
  return result;
}
function timestamp(value) {
  const instant = Date.parse(text(value, 40));
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) fail();
  return value;
}
const validators = {
  targetAgentId: id, clientMessageId: id, sessionId: id, approvalId, waitId: id,
  generation: value => text(value, 256), commandId: id, limit: value => integer(value, 1, 100),
  cursor: value => value === null ? null : text(value, 4096),
  beforeMessageId: value => value === null ? null : text(value, 256),
  text: value => text(value, 32_000), reason: value => text(value, 1000),
  intent: value => choice(value, ['auto', 'task', 'message']),
  action: value => choice(value, ['pause', 'cancel', 'steer', 'resume', 'archive', 'restore']),
  approved: boolean, revision: integer, expectedRevision: integer, limits, onboarding,
  scheduleId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail(); return value; },
  title: value => text(value, 200), startAt: timestamp,
  intervalMs: value => value === null ? null : integer(value, 60_000, 365 * 86_400_000),
  maxOccurrences: value => integer(value, 1, 1000),
};
const required = {
  'agents.message.send.request': ['clientMessageId', 'text'],
  'agents.action.request': ['action'],
  'agents.approval.decide.request': ['approvalId', 'approved'],
  'agents.authoring.preview.request': ['authoring'],
  'agents.create.request': ['expectedRevision'],
  'agents.update.request': ['expectedRevision'],
  'agents.delete.request': ['expectedRevision'],
  'agents.session.request': ['sessionId'],
  'agents.schedules.create.request': scheduleFields,
  'agents.schedules.update.request': [...scheduleFields, 'expectedRevision'],
  'agents.schedules.cancel.request': ['scheduleId', 'expectedRevision'],
};
export function normalizeAgentCommand(value, allowedModes) {
  const keys = AGENT_FIELDS[value.type];
  const result = { type: value.type };
  const preview = value.type === 'agents.authoring.preview.request';
  if (value.type === 'agents.create.request' || value.type === 'agents.update.request') {
    if (Object.hasOwn(value, 'authoring')) {
      if (['definition', 'limits', 'onboarding'].some(key => Object.hasOwn(value, key))) fail();
    } else if (!Object.hasOwn(value, 'definition') || !Object.hasOwn(value, 'limits')) fail();
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      if ((key === 'targetAgentId' && !preview) || required[value.type]?.includes(key)) fail();
      continue;
    }
    if (key === 'definition') result[key] = definition(value[key], allowedModes);
    else if (key === 'authoring') result[key] = authoring(value[key], allowedModes, preview);
    else result[key] = validators[key](value[key]);
  }
  if (value.type === 'agents.approval.decide.request') {
    const durable = ['waitId', 'generation', 'revision', 'commandId'];
    if (durable.some(key => Object.hasOwn(result, key)) && !durable.every(key => Object.hasOwn(result, key))) fail();
  }
  if (['archive', 'restore'].includes(result.action) && result.expectedRevision === undefined) fail();
  if (['resume', 'steer'].includes(result.action) && result.text === undefined) fail();
  if (result.intervalMs === null && result.maxOccurrences !== 1) fail();
  if (Buffer.byteLength(JSON.stringify({ ...result, allowedModes })) > 128 * 1024) fail();
  return result;
}
