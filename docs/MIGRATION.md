# Moving to pairing

Installing the package does not change existing services or applications. Use a
separately approved cutover after real-device verification.

The chat envelopes, runtime bridge and runtime credential grants remain compatible.
Authentication changes: the new client uses local-operator pairing instead of
email. Old in-memory sessions cannot be imported. Existing devices must pair to
the new service, receiving separate credentials bound to its HTTPS origin.

1. Back up the current private configuration and deployed version.
2. Prepare a separate candidate endpoint and private state with a unique test
   runtime identity. Do not attach two active runtimes using the same ID.
3. Issue pairing locally; verify pairing, restart persistence, runtime discovery,
   history, chat, steering, approvals and revocation through the actual app.
4. Perform the approved service/client cutover while retaining a rollback path.

The new configuration has `publicOrigin`, `port`, `stateDirectory`, and
`runtimeGrants`. Remove old `allowedEmail` and `mail` settings; they are rejected.
`ABOT_SOCKET_CONFIG` accepts `SOCKET_V2_CONFIG` as a path alias. No mail-token
variable is used. The existing runtime adapter needs configuration only, not
source changes. Setup generates new runtime credentials rather than rotating or
migrating an existing installation automatically.

After cutover, retain the private state directory through upgrades. Device
sessions persist there. Socket connections and transient subscriptions still
disappear on restart; durable request ownership is described below. Interrupted
requests must be reconciled against runtime state before retry.

## Durable request ownership schema upgrade

Schema v4 adds a routing-ownership table to the existing private database.
Schemas v1, v2 and v3 upgrade transactionally, preserving owner identity, paired
devices, pending pairing, notification metadata, preview keys and delivery queues.
No new dependency or additional state file is required.

New durable requests record their runtime, session, request, owner and
initiating device identifiers, plus routing status and timestamps. A paired owner
device can also recover an unowned computer-created request: after a fresh
response from the authorized runtime verifies the exact session and request, the
Socket records that ownership with the adopting device. Existing ownership is
never reassigned to a different owner or session. There is no bulk import, and
historical events cannot establish ownership.

This table contains no conversation content, approval presentation, decision or
continuation. The runtime remains authoritative for pending approvals and decision
receipts. Recovery requires a compatible client and `request_approvals_v1` on the
selected runtime; legacy requests are not automatically converted during upgrade.

Ownership is persisted before forwarding a new request. Open or uncertain records
do not expire or get evicted; a full 512-record ledger rejects new admissions.
Only confirmed terminal records expire after 12 hours. Confirmed whole-session
deletion retires that session's records. Revoking the originating
device does not erase ownership: another paired device of the same owner can
still recover the request, but revoked credentials cannot connect or receive push.
An interrupted send is never automatically resent from this ledger.

Stop the service and preserve the private state directory and matching code before
upgrading. Older binaries reject schema v4. Rollback requires restoring the
matching pre-upgrade database snapshot and code while stopped; do not delete state
to make an old binary start. Reconcile device revocations and deliveries made
since that snapshot before resuming service. This source change alone does not
upgrade or restart a deployed service.


## Notification preview schema upgrade

Schema v3 adds a device-scoped preview-key table and nullable encrypted-preview
column on the existing outbox. Both schema v1 and v2 upgrade transactionally;
paired-device tokens, pending pairing, owner identity, notification metadata and
generic delivery queues are preserved. Preview remains off until that device
explicitly provisions a key after push registration. No runtime changes are needed.

Stop the service and back up the private state directory and matching deployed
code before upgrading. Older binaries reject schema v3. Rollback requires restoring
the matching pre-upgrade database snapshot together with old code while stopped;
do not point an old binary at the migrated state or delete the database to make it
start. Restoring a snapshot also restores its older device/revocation/delivery state,
so reconcile changes made since that snapshot before resuming service.

For gateway delivery, upgrade the publisher gateway before clients enable previews.
Keep previews off until compatible client support is installed. Old clients and
opted-out devices retain the original generic push behavior. This source change
alone does not deploy or enable preview delivery on an existing installation.
