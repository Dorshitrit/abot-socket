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
sessions persist there; transient relay routes still disappear on restart.
Interrupted requests must be reconciled against runtime history before retry.


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
