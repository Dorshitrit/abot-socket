import { createHash } from 'node:crypto';
import { AGENT_NOTIFICATION_RETENTION_MS, parseAgentNotification } from '../src/protocol/agent-notification-protocol.mjs';

export function agentNotificationFrame(now, fields = {}) {
  return { type: 'agents.notification', targetAgentId: 'researcher', missionId: 'mission-1',
    messageId: 'reply:message-1', reason: 'reply', createdAt: now,
    expiresAt: now + AGENT_NOTIFICATION_RETENTION_MS, output: 'The research is ready.',
    eventId: createHash('sha256').update(fields.messageId ?? 'reply:message-1').digest('hex'), ...fields };
}

export function agentNotificationEvent(now, fields = {}) {
  const event = parseAgentNotification(agentNotificationFrame(now, fields), now);
  if (!event) throw new Error('Invalid notification fixture');
  return event;
}
