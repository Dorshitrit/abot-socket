# Changelog

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
