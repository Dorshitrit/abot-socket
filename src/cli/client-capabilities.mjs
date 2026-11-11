/** Socket-owned API support; runtime identity/features remain separately scoped. */
export function clientCapabilities() {
  return { cancel: false, durableApprovals: false, sessionMutation: true, notifications: true };
}
