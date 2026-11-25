/** Keep legacy session rows byte-shape compatible; Agent rows never masquerade as sessions. */
export function projectNotificationDestination(row) {
  const { target, agentId, missionId, messageId, reason, ...item } = row;
  if (target !== 'agent') return item;
  delete item.sessionId;
  delete item.requestId;
  return { ...item, target: 'agent', agentId, missionId,
    ...(messageId === null ? {} : { messageId }), reason };
}
