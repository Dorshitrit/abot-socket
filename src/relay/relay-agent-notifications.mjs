import { AGENT_NOTIFICATIONS_FEATURE, parseAgentNotification } from '../protocol/agent-notification-protocol.mjs';
import { AGENTS_FEATURE } from '../protocol/agents-protocol.mjs';

/** Durable notification acknowledgement is separate from transient workspace invalidation. */
export class RelayAgentNotifications {
  constructor({ now, observe, transmit }) {
    this.now = now; this.observe = observe; this.transmit = transmit;
  }

  supported(runtime) {
    if (typeof this.observe !== 'function') return false;
    if (!runtime.features.includes(AGENTS_FEATURE)) return false;
    return runtime.features.includes(AGENT_NOTIFICATIONS_FEATURE);
  }

  registration(runtime) {
    return this.supported(runtime) ? { agentNotifications: { version: 1 } } : {};
  }

  receive(runtime, body) {
    if (!this.supported(runtime)) return;
    const event = parseAgentNotification(body, this.now());
    if (!event) return;
    try {
      if (this.observe(runtime.runtimeId, event) !== true) return;
    } catch { return; } // No ACK: Runtime retains its event and retries the same identity.
    this.transmit(runtime.peer, { type: 'agents.notification.ack', eventId: event.eventId });
  }
}
