# Protocol and compatibility

This candidate retains the Socket v2 chat transport contract and replaces email
authentication with operator-issued pairing. It does not change
runtime source or expose the complete runtime Web UI API. The `/health` value
`version: 2` identifies the protocol family, not a package release number.

## HTTP

Use the configured HTTPS origin. JSON body limits depend on the route:

| Route | Maximum JSON request body |
| --- | --- |
| `POST /v2/pairing/redeem`, `POST /v2/notifications/read`, `POST /v2/notifications/presence` | 4 KiB (4096 bytes). |
| `PUT /v2/notifications/push` | 8 KiB (8192 bytes). |
| `PUT /v2/notifications/push/preview` | 512 bytes. |

These are application limits; a reverse proxy can impose a smaller limit. The
generated direct-proxy plans currently cap request bodies at 4 KiB. The separate
notification gateway accepts JSON bodies up to 8 KiB and needs its own proxy
configuration. Field validation still applies within each body limit.

Responses are `no-store`. Host must match the configured origin, and a supplied
browser Origin must match it exactly. The local proxy requirements apply to all
routes, including `/health`.

| Method and path | Request / response |
| --- | --- |
| `GET /health` | `{ok:true, version:2}`; no account or runtime details. |
| `POST /v2/pairing/redeem` | `{pairingId, code, deviceName}` → `{token, expiresAt, session:{id,subject,deviceName}}`. |
| `GET /v2/auth/sessions` | Bearer session token → `{sessions:[{id,deviceName,createdAt,expiresAt,current}]}`. |
| `DELETE /v2/auth/sessions/:id` | Bearer session token → `{revoked}`. |
| `POST /v2/auth/logout` | Bearer session token → `{ok:true}`. |
| `GET /v2/runtimes` | Bearer session token → `{runtimes:[...]}` with IDs, online state, model catalog, allowed modes, and capabilities. |

`pairingId` is a random 32-character base64url temporary key; `code` is exactly
six decimal digits, including leading zeros. Both are required. A bundle is
valid for five minutes and five failed attempts; consume and device issuance
share a database transaction. A retry after a lost success response cannot reuse
it: the operator must create a fresh bundle. Neither secret belongs in a URL.
The ordinary Socket API has no HTTP endpoint for generating pairing bundles.
The optional, separately enabled [app-review portal](APP-REVIEW.md) exposes an
authenticated `POST /review/pair` on its own listener/origin, bound to a dedicated
review installation. It is not part of the ordinary Socket API. Legacy email
endpoints are no longer supported.

### Pairing QR, version 1

The operator CLI can encode the existing bundle as raw UTF-8 JSON in a QR:

```json
{"type":"abot-pairing","version":1,"serverUrl":"https://socket.example.test","pairingId":"0123456789abcdefghijklmnopqrstuv","code":"000123","expiresAt":1800000300000}
```

This example is illustrative, not a usable pairing. `expiresAt` is Unix time in
milliseconds; the server remains authoritative for validity. The code is a string
to preserve leading zeros. The QR contains only these six fields, never a runtime
token, permanent device token, configuration file, or secret-bearing URL/deep link.

Clients validate the type/version and field shapes, accept only a canonical HTTPS
origin, display the destination for confirmation, and then use the existing
`POST /v2/pairing/redeem`. Scanning alone must not contact the destination. Suppress
duplicate camera detections while confirmation or redemption is in progress.
The existing expiry, attempt limits and one-use transaction apply unchanged;
creating a new bundle replaces only the pending pairing, not existing devices.
The QR is a bearer enrollment secret, so it must not be retained in logs or sent
to external QR-generation services.

An expired, unknown, consumed or wrong pairing returns `invalid_code` / 401.
General HTTP limits and source/global code-verification limits return `rate_limited` / 429.
Verification quotas apply only after matching an unexpired, unlocked pending pairing
key; malformed, unknown, expired or already-locked pairing requests do not spend them.
A full device list
returns `device_limit` / 429; free a slot locally. Malformed device names return
`invalid_request` / 400 without consuming an otherwise valid pairing.

## Native client WebSocket

Connect to `/v2/realtime` using `Authorization: Bearer <device-session-token>` in
the HTTP upgrade. Credentials are not accepted in URL query parameters. Native
clients should store the token in the platform's secure credential store.
Browser WebSocket APIs cannot set this header; browser support needs its own
designed authentication path.

On connection, the relay sends `authenticated` with the session expiry and
capability flags. Client commands use `{id, runtimeId, body}`. IDs must be unique
per connection. Supported body types are:

- `run_request`, `steer_request`, `tool_approval_response`;
- `session.list.request`, `session.snapshot.request`, `request.events.request`;
- `session.delete.request`, `session.messages.clear.request`, `session.message.delete.request`;
- `attachment.upload.request`, `attachment.fetch.request`;
- relay-local `subscribe_request` for a known request belonging to this owner.

The relay returns `relay.ack`, `relay.error`, `relay.response`, or `relay.event`
with the appropriate command ID, runtime ID, and body. An acknowledgement means
dispatched or queued, not completed. Runtime correlations belong to the relay;
the client cannot choose them. Unknown command fields and unsupported operations
are rejected rather than forwarded as a generic admin API.

Tool permission values are `ask`, `full_access`, and `full_plus`, constrained by
the runtime grant. Setup grants only `ask`. The model catalog and supported
reasoning controls come from the connected runtime, not a hardcoded model list.

### Session mutations

Each runtime in `/v2/runtimes` and the WebSocket `authenticated` frame includes
`capabilities.sessionMutation: true` for these three relay operations. Clients must treat an
absent/false flag as unsupported and require explicit user confirmation.

| Request body | Response body (inside `relay.response`) |
| --- | --- |
| `{type:'session.delete.request', sessionId}` | `{type:'session.delete.response', ok, sessionId, deleted, deletedMessages, deletedRequests}` |
| `{type:'session.messages.clear.request', sessionId}` | `{type:'session.messages.clear.response', ok, sessionId, cleared, deletedMessages, deletedRequests, updatedAt}` |
| `{type:'session.message.delete.request', sessionId, messageId}` | `{type:'session.message.delete.response', ok, sessionId, messageId, deleted, updatedAt, deletedRequestId?, deletedRequestEvents?}` |

Use canonical message IDs from a fresh runtime snapshot, not local UI IDs.
Numeric message IDs are normalized to strings. Only `ok:true` together with
`deleted:true` / `cleared:true` confirms a change; reload canonical history after
the result. The runtime's single-message delete removes only that message row,
plus its associated request replay/context and memory checkpoints; sibling
message rows remain. Session deletion/clearing follows the existing runtime's
history and attachment cleanup semantics.

The relay rejects observed active/uncertain requests and in-flight uploads with
`session_busy`. Before forwarding a mutation it reads a complete snapshot with
`includeRequests:true`; active requests prevent deletion, and an incomplete or
unrecognized snapshot returns `session_state_unavailable`. No snapshot contents
are added to the mutation response. A pending mutation blocks another mutation,
new run or upload in that session (`session_mutation_pending`). It retains this
guard after client disconnect until the outcome or the shared 30-second timeout.
A client disconnected during the read check cannot begin deletion.

This check is not an atomic lock over independent Web UI clients. A request
started directly at the runtime after the check can race with deletion; the
runtime fences deleted generations and that request may be cancelled. Wait for
work on all clients to finish. `outcome_unknown` never authorizes an automatic
retry: reload authoritative history first. Missing sessions report
`session_not_found`; runtime failures remain failures.

## Runtime bridge

Connect to `/agent-bridge` with the separate runtime Bearer token, then send the
existing `{type:'register', agentId, features?, modelCatalog?}` message. The
registered ID must match the credential's grant. A second connection cannot
replace an already connected runtime with the same ID. Client device credentials
cannot authenticate this role.

## Recovery and capability limits

- A timeout or disconnect can return `outcome_unknown`; do not retry commands
  automatically. Read canonical runtime history/replay to reconcile the result.
- Live `eventSequence` and replay `seqNo` are separate counters. `afterSeq` uses
  the persisted replay counter only.
- Approval authority requires an observed pending approval for the correct
  runtime and request. Historical replay alone does not restore that authority.
  Positive approval expires after five minutes; an explicit decline can remain
  possible once on that same active runtime connection and request.
- `cancel` and `durableApprovals` are advertised as false. Restart, cron,
  configuration, and generic administration are not exposed.
- The relay keeps bounded temporary routing state. It is not an offline queue,
  durable conversation store, or exactly-once execution service.

Use the new pairing-capable client. Email-only personal builds cannot enroll
through this authentication contract. Existing runtime adapters are unchanged.

## Notifications

`capabilities.notifications: true` advertises the authenticated notification API.
Notifications are owned by the **paired device that initiated the request**, not
by its current WebSocket connection. Other paired devices cannot list or mark
that device's records. There are no new unsolicited WebSocket frame types;
clients poll the inbox while foregrounded and reconcile on resume or push tap.

| Method and path | Request / response |
| --- | --- |
| `GET /v2/notifications?limit=50&before=<cursor>` | Device inbox, descending time; limit 1–100; opaque optional cursor. |
| `POST /v2/notifications/read` | `{ids:[...]}` (maximum 100) → `{ok:true}`. Unknown or foreign IDs have no effect. |
| `POST /v2/notifications/presence` | `{foreground:boolean,runtimeId?,sessionId?}` → `{ok:true}`; a session requires its runtime. |
| `PUT /v2/notifications/push` | `{provider:'fcm',token}` or `{provider:'gateway',endpointId,sendToken}` → `{ok:true}`. |
| `DELETE /v2/notifications/push` | Remove this device's push registration, preview key and queued deliveries → `{ok:true}`. |
| `PUT /v2/notifications/push/preview` | Exact `{keyId,key}` → `{ok:true}`; opt in after registering push. Replaces the device's key. |
| `DELETE /v2/notifications/push/preview` | Remove this device's preview key and queued ciphertext, retaining generic deliveries → `{ok:true}`. |

The inbox response is `{version:1,items,nextCursor,unreadCount,unreadByRuntime,
unreadBySession,delivery,registration,preview}`. Each item is
`{id,runtimeId,sessionId,requestId,kind,createdAt,readAt,expiresAt}`; timestamps
are epoch milliseconds, and `readAt` is null until read. `kind` is `completed`,
`failed` or `approval_required`. `unreadByRuntime` maps runtime IDs to counts;
`unreadBySession` maps runtime IDs to session-ID/count maps. `delivery` is
`{mode:'disabled'|'fcm'|'gateway',configured:boolean}`, and `registration` is
`{enabled:boolean}`. `preview` is `{supported:true,enabled:boolean,keyId:string|null}`.
Older servers omit `preview`; clients treat that as unsupported and off. Keys
and registration credentials are never returned by this API.

Foreground presence lasts 45 seconds. Renew while active; `foreground:false`
clears it. Presence is advisory: the phone may be suspended before its background
update arrives, so presence alone never marks records read or suppresses delivery.
Only an explicit authenticated read acknowledgement consumes records and cancels
queued deliveries. Clients acknowledge fetched IDs after showing the conversation.
Counts share the same ledger; they are not runtime transcript read receipts.
Push taps resolve the notification ID through this authenticated inbox
before opening a conversation; a push payload grants no execution or approval authority.

Only validated live `completed`, `failed` and `tool.approval.required` frames for
known relay requests create records. Streaming/progress events and replay do not.
Granted/rejected/terminal events cancel pending approval deliveries. Approval
notifications expire after five minutes; other records after at most seven days
or device credential expiry. Storage is capped at 500 records per device.
Expiration, logout and revocation remove registrations and pending deliveries.
The outbox retries at most five times, with bounded backoff. Duplicate source
events are deduplicated, but provider delivery is not an exactly-once guarantee.

The inbox and queued deliveries survive relay restarts. In-flight request routing
does not: this is not a complete runtime-wide event subscription or an offline
execution queue. Web UI, schedules and autonomous SPARK events are outside this
phase. Never interpret a missing notification as a failed request or auto-retry it.

Push is disabled unless private operator configuration includes
`notifications.delivery`. A self-built client uses
`{type:'fcm',serviceAccountFile:'./private-sender.json'}`; the path is resolved
relative to the private socket configuration, and sender credentials stay on
that operator's server. The client must belong to the same configured Firebase
project. Official builds can use `{type:'gateway',gatewayOrigin:'https://<trusted-host>'}`
with a separately enrolled endpoint. Clients cannot choose a gateway URL or send
provider credentials through the registration API. A missing or mismatched
configured transport returns `409 push_unavailable`; ordinary chat and the inbox
continue to work with delivery disabled.


### Optional encrypted answer previews

Previews are off by default and enabled per paired device, only after an active
push registration exists. The app generates a random 32-byte AES-256-GCM key and
16-byte key ID, sends both over authenticated HTTPS to its own Socket, and enables
local display only after acknowledgement. Both fields use canonical unpadded
base64url. No email, additional identity provider, or runtime change is involved.
Provider-token rotation preserves the preview setting. Key replacement clears
pending ciphertext. Disabling previews clears the key and ciphertext while leaving
the generic queue intact; unregistering push removes the entire delivery queue.
In-flight sends are aborted where possible, but provider-accepted notifications
cannot be recalled. The client must discard its key immediately on disable/logout.

Only a nonempty final `completed.output` is eligible. The Socket takes a bounded
prefix, removes unsafe controls and bidi override characters, and truncates on a
Unicode scalar boundary to at most 1024 UTF-8 bytes, including an ellipsis when
needed. It is an excerpt, not secret redaction. Approval, failure and progress
content is never included. No plaintext preview is stored in the inbox or outbox.
The inbox remains metadata-only; encrypted content exists only in the pending
outbox and is removed on delivery, read acknowledgement, revocation or expiry.

The exact encrypted envelope is `{v:1,keyId,nonce,ciphertext,expiresAt}`. Nonce is
12 random bytes. Ciphertext contains encrypted UTF-8 followed by the 16-byte GCM
authentication tag (at most 1040 bytes), using canonical unpadded base64url.
Authenticated additional data is UTF-8, with literal newline separators:

```text
ABot push preview v1
<keyId>
<notificationId>
<expiresAt decimal epoch milliseconds>
```

The expiry equals notification expiry, capped by the device credential and seven
days. The device rejects an unknown key, altered ID/expiry/content, expired data
or malformed envelope and retains a generic alert. The gateway receives neither
the key nor plaintext. Its `/v1/deliver` accepts an optional strictly validated
`preview` field alongside the existing fixed delivery fields. Upgrade the gateway
before enabling previews; older gateways do not accept this field.

Encrypted FCM sends have no top-level `notification` or `android.notification`.
Their string-valued data is `notificationId`, `abotPreview` (envelope JSON),
`abotKind` (`completed`), `abotExpiresAt` and `abotBadge`. Android renders the
notification locally. APNs retains a generic alert and sets `mutable-content:1`
for the app's notification-service extension. Generic sends keep their existing
payload. Serialized provider envelopes are bounded to 4096 UTF-8 bytes. Foreground
display and navigation continue to use the authenticated inbox; push cannot grant
access or approval authority.
