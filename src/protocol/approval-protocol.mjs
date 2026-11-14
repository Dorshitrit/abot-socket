import { MAX_TEXT_BYTES, approvalId, boolean, fail, id, integer, optional, string } from './protocol-validation.mjs';

export const APPROVAL_FIELDS = Object.freeze({
  'request.approvals.request': ['sessionId', 'requestId'],
  'request.approval.decide.request': ['sessionId', 'requestId', 'approvalId', 'approved', 'reason',
    'generation', 'waitId', 'revision', 'commandId'],
});

export const APPROVAL_RESPONSES = Object.freeze({
  'request.approvals.request': 'request.approvals.response',
  'request.approval.decide.request': 'request.approval.decide.response',
});

const WAIT_FIELDS = ['generation', 'waitId', 'revision', 'commandId'];

export function isApprovalCommand(type) {
  return typeof type === 'string' && Object.hasOwn(APPROVAL_FIELDS, type);
}

export function durableApprovalMode(value) {
  if (value !== 'durable_v1') fail();
  return value;
}

/** Validate transport input only; current approval state and decisions belong to the runtime. */
export function normalizeApprovalCommand(value) {
  const result = { type: value.type, sessionId: id(value.sessionId), requestId: id(value.requestId) };
  if (value.type === 'request.approvals.request') return result;
  result.approvalId = approvalId(value.approvalId);
  result.approved = boolean(value.approved);
  optional(value, result, 'reason', reason => string(reason, MAX_TEXT_BYTES, { controls: true }));
  if (!WAIT_FIELDS.some(key => Object.hasOwn(value, key))) return result;
  if (!WAIT_FIELDS.every(key => Object.hasOwn(value, key))) fail();
  result.generation = id(value.generation);
  result.waitId = id(value.waitId);
  result.revision = integer(value.revision);
  result.commandId = id(value.commandId);
  return result;
}
