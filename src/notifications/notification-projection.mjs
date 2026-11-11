export const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const APPROVAL_NOTIFICATION_MS = 5 * 60 * 1000;

/** Select only final results and live approval requests, never token/progress text. */
export function projectNotificationEvent(identity, body, now) {
  if (body.type === 'completed' || body.type === 'failed') {
    return { ...identity, kind: body.type, approvalId: '', createdAt: now,
      expiresAt: now + NOTIFICATION_RETENTION_MS };
  }
  if (body.type !== 'event' || body.name !== 'tool.approval.required') return null;
  if (typeof body.approvalId !== 'string' || !body.approvalId || body.approvalId.length > 512) return null;
  return { ...identity, kind: 'approval_required', approvalId: body.approvalId,
    createdAt: now, expiresAt: now + APPROVAL_NOTIFICATION_MS };
}

export function closesApprovalNotifications(body) {
  if (body.type === 'completed' || body.type === 'failed') return true;
  if (body.type !== 'event' || !['tool.approval.granted', 'tool.approval.rejected'].includes(body.name)) return false;
  return typeof body.approvalId === 'string' && body.approvalId.length > 0 && body.approvalId.length <= 512;
}
