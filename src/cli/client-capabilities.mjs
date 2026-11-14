import { supportsSparkChat } from '../protocol/spark-chat-protocol.mjs';

/** Socket-owned API support; runtime identity/features remain separately scoped. */
export function clientCapabilities({ ownership, runtime } = {}) {
  return { cancel: false, durableApprovals: supportsDurableApprovals(ownership, runtime),
    sessionMutation: true, notifications: true, sparkChat: supportsSparkChat(runtime) };
}

function supportsDurableApprovals(ownership, runtime) {
  if (!ownership) return false;
  if (runtime === undefined) return true;
  if (runtime.online !== true) return false;
  return Array.isArray(runtime.features) && runtime.features.includes('request_approvals_v1');
}
