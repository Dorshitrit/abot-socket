# Security boundaries

ABot Socket is a single-owner relay. Each installation has its own runtime
grants, device credentials, private state and HTTPS origin. Every paired device
represents that owner; this is not tenant isolation for unrelated users.

## Authentication and credentials

- Ordinary installations issue pairing through local operator commands. A random temporary
  pairing key and six-digit code expire after five minutes or one successful use.
  Five incorrect code attempts invalidate the challenge; expiry and attempts
  persist across server restarts. Source and global verification limits apply only
  to requests identifying an unexpired, unlocked pending pairing key. Unrelated
  requests do not spend that quota; general HTTP request limits still apply.
- Generating fresh pairing details replaces only the pending challenge, not
  existing devices. Consumption and device creation are atomic in SQLite.
- Device tokens are independently random. Only token digests are stored by the
  server. Sessions last at most 30 days without sliding renewal, survive restarts
  and can be revoked locally or by an authenticated owner device. Revocation and
  expiry close existing WebSockets. At most 10 active device sessions are allowed.
- The app binds credentials to the selected HTTPS origin in iOS Keychain and
  refuses redirects. The pairing key is temporary, not a permanent shared key.
- Runtime tokens are separate and bound to one runtime ID. Only their SHA-256
  digest is in server configuration. Never put a runtime token into the app.
- Configuration is private; state directories are 0700 and files 0600. State
  symlinks, unexpected entries and unsafe ownership/permissions are rejected.
  Keep installation files outside source, and never log codes, keys or bodies.
- Setup and `pair` intentionally display new one-time details to the operator.
  The ordinary Socket HTTP API does not generate or expose pairing bundles and
  offers no email fallback or login bypass.
- A separately enabled [app-review portal](APP-REVIEW.md) can generate and display
  bundles after reviewer authentication. It binds to a dedicated review
  installation, uses a separate listener/origin and must not share production
  state or runtime credentials. Protect its access details as credentials.

## Trusted components

The relay, its local reverse proxy and runtime computers are trusted. There is no
email delivery or third-party identity provider. HTTPS/WSS protects transport;
the relay can read routed messages and attachments. This is not end-to-end
encryption against its operator or a compromised relay host.

Follow [the proxy requirements](SELF-HOSTING.md#3-configure-https-and-the-proxy-boundary).
The listener is private loopback. Proxy headers must be overwritten by a trusted
local proxy; forwarded addresses are not trustworthy simply because a header
exists. CDN chains require a separate trusted-peer policy.

## Permission and routing limits

Runtime grants limit the permitted tool modes; `ask` is the setup default.
Requests and responses are bound to their runtime connection and private
correlation. Clients cannot use this relay to call generic runtime administration,
restart, or scheduling. Session deletion/clearing is limited to three validated
commands for an authorized runtime, with private response correlations and a
read-before-delete check for active work. See the
[mutation contract and its cross-client race limit](PROTOCOL.md#session-mutations).

The relay validates command shapes, bounds frames, connections and routing state,
and rejects unsupported operations. These controls do not make a compromised
authorized device harmless: it can act within its owner's configured grants.
Revoking that device session removes its relay access.

Paired owner devices can continue requests started directly on an authorized
runtime. Before admitting an unowned request for approval recovery, the relay
verifies its exact session/request identity through a fresh response from that
runtime connection. It never replaces an existing ownership binding for a
different owner or session. The runtime still validates every approval decision
against its current wait; a session snapshot is not approval authority.

The relay does not automatically retry uncertain operations, restore approval
authority from historical events, or provide exactly-once execution. After a
disconnect, reconcile against runtime history before resubmission.

## SPARK chat boundary

SPARK chat uses the same paired-device runtime access and tool-permission ceiling
as ordinary chat. Opening it exposes only the canonical session, selected model,
permission mode and model readiness, never the full preferences or internal
diagnostics. Runtime support is required before dispatch. The runtime remains
responsible for its marked companion and rereads its policy at every new send;
the relay never caches that policy as permission to execute. Existing approval
ownership and recovery checks remain in force. SPARK configuration and autonomous
activity are outside this API.

## Push preview boundary

Answer previews are opt-in per paired device and off by default. The already
trusted Socket sees final answers and encrypts a bounded excerpt with a random
per-device AES-256-GCM key provisioned over the existing authenticated HTTPS API.
That shared key is stored in the restricted Socket state; it is not sent to the
publisher gateway, FCM or APNs. The gateway validates and forwards ciphertext only.
This protects preview content from delivery intermediaries; it does not protect
against a compromised Socket, device, or its operator. It is not a transcript
end-to-end encryption claim.

Keys are scoped to the paired device, and notification ID and expiry are bound
into authenticated data. Key replacement, disable, logout and revocation remove
queued ciphertext; provider token rotation retains the key. The inbox never
returns preview content or keys. Pending ciphertext is deleted after delivery,
read or expiry. SQLite deletion is logical cleanup, not forensic secure erasure;
protect state backups as credentials. The OS may retain displayed notifications,
and previews can reveal answer content on a lock screen according to user settings.
Disabling cannot recall alerts already accepted or displayed by the provider/OS.
The device must remove its local key immediately so later queued ciphertext falls
back to generic text. Unsupported, expired or invalid payloads also fail generic.

## Validation status

Local tests use dummy principals, a mock runtime. Some
tests exercise loopback HTTP/WebSocket transport. Configuration checking itself
does not send email or open a listener. None of these checks proves a deployed
proxy, domain, or real client/runtime behavior.

Package publication is not a claim of a completed independent security
audit. When investigating a problem, use synthetic credentials and redact
configuration, tokens, codes, and conversation content from reports.
