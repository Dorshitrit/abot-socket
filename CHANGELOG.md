# Changelog

## 0.3.0 - 2026-11-25

### Added

- Access the runtime's Agents workspace through compatible paired clients,
  including messages, tasks, schedules, authoring previews and approval decisions.
  Runtime grants and Agent permission levels continue to govern each operation.
- Keep Agent views current through scoped subscriptions, reconnect invalidation
  and bounded public mission and reply summaries.
- Deliver durable Agent notifications to compatible paired clients without an
  open Web connection, with replay deduplication and delivery receipts. Older
  clients retain session-only notification behavior.
- Enroll another computer with `abot-socket add-runtime` without rerunning setup
  or replacing existing runtime grants and phone pairing. The new grant starts
  with Ask permission; credentials are written to a new private output directory.

### Upgrade notes

- Private SQLite state upgrades transactionally from schemas v1–v4 to v5,
  preserving paired devices, pending pairing, existing notifications and delivery
  queues, encrypted previews and durable request ownership. Stop the service and
  back up private configuration, state and matching code before upgrading.
  Version 0.2.0 cannot open schema v5; rollback requires both the pre-upgrade state
  and old code. See [Migration](docs/MIGRATION.md#agent-notification-schema-upgrade).
- Agents workspace access requires the runtime's `agents_v1` capability. Agent
  notifications additionally require `agents_notifications_v1`, explicit runtime
  negotiation and a compatible client that opts in. Existing chat and notification
  paths remain available to older clients.
- After `add-runtime`, deliberately restart the configured Socket service to load
  the new grant. The command does not start or restart services itself.
- Node.js 24 or later remains required. Dependencies are unchanged.

## 0.2.0 - 2026-11-14

### Added

- Recover pending tool approvals after client reconnects and Socket or runtime
  restarts, using persistent request ownership and runtime-authoritative waits.
- Continue and approve requests started on the computer from a paired client,
  after the current runtime confirms the exact session and request. Existing
  ownership is never reassigned to another owner or session.
- Open and chat with the runtime's SPARK companion through compatible clients,
  using its configured model and permissions. This does not expose SPARK
  management, settings writes or proactive activity.

### Fixed

- Restore scoped live request delivery when recovering an owned request, without
  rerunning it or reconstructing events missed during disconnection.

### Upgrade notes

- New features require a compatible client and the selected runtime's
  `request_approvals_v1` or `spark_chat_v1` capability. Legacy chat and live-only
  approval behavior remain available when the new capabilities are not used.
- Private SQLite state upgrades transactionally from schema v1, v2 or v3 to v4.
  Existing pairing, device credentials, notification metadata, preview keys and
  delivery queues are preserved. Stop the service and back up its private state
  and matching code before upgrading; rollback requires both the pre-upgrade
  state and old code. See [Migration](docs/MIGRATION.md).
- Node.js 24 or later remains required. Dependencies and the HTTP/WebSocket
  protocol envelope are unchanged.

## 0.1.0 - 2026-11-11

- Initial MIT-licensed npm release with authenticated runtime relay, QR/manual
  pairing, device revocation, notification delivery and optional encrypted
  previews, and CLI setup/deployment guidance.
