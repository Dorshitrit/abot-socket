# ABot Socket

A self-hosted chat relay between a native ABot client and your ABot Runtime
instances. You operate the relay, pair your devices, and connect your own
computers. The relay does not require an ABot-hosted account or backend.

The source is available under the [MIT license](LICENSE). Install the versioned
`@abot-ai/socket` package from npm, or build a local tarball from source.
See the [changelog](CHANGELOG.md) for release notes and upgrade requirements.

## Install and prepare

Start with [Installation and first connection](docs/INSTALLATION.md), the consumer
guide for installing the command, preparing a server, connecting a runtime and
pairing the app by QR or manual entry.

```sh
npm install --global @abot-ai/socket@0.2.0
abot-socket setup
```

The command requires Node.js 24 or later. Its terminal wizard creates private
configuration/state and, on Linux, reviewable systemd/HTTPS proxy files. The
operator supplies DNS, TLS, service activation and the runtime's bridge settings.
Neither npm installation nor setup activates those services; no install hook runs.

- [Installation](docs/INSTALLATION.md): wizard, defaults, runtime connection and pairing.
- [Deployment](docs/DEPLOYMENT.md): explicit Linux service and HTTPS activation.
- [Self-hosting](docs/SELF-HOSTING.md): configuration, operation and the proxy trust boundary.
- [Protocol](docs/PROTOCOL.md): pairing API and existing runtime bridge.
- [Security](docs/SECURITY.md): authentication, trust boundaries and limitations.
- [Migration](docs/MIGRATION.md): moving an existing installation deliberately.
- [App review preparation](docs/APP-REVIEW.md): a separate review installation,
  protected renewable pairing access and the remaining deployment/device checks.

`abot-socket start` runs the relay in the foreground. `abot-socket doctor` checks
public HTTPS relay health without credentials; runtime readiness is verified in
the paired app. `abot-socket pair` creates fresh one-time pairing details and
displays a private QR in a capable terminal. Scanner-enabled clients can scan it
and confirm the server address; manual entry remains available.

## Scope

One installation represents one owner, with up to 10 paired devices and 16
runtimes. Pairing requires a six-digit code and a separate random temporary key
created locally by the operator. Both expire after five minutes or one successful
use. There is no email delivery or central authentication provider.

ABot App scans the private pairing QR and asks you to confirm its server address.
Manual code, HTTPS URL and temporary-key entry remains available. The app receives
its own device credential; never copy the runtime credential into the app.

The relay supports chat, steering, tool approvals, runtime history, model selection
and attachments through the runtime Bridge. Compatible clients can recover pending
approvals across reconnects and restarts, continue requests created on their
computer, and open the runtime's SPARK companion chat. SPARK model settings and
permissions remain runtime-owned; management and proactive activity are not exposed.
These features require the selected runtime to advertise `request_approvals_v1`
or `spark_chat_v1` respectively; older runtimes retain the legacy chat path.
The relay does not execute models or store conversation history. Configure the
runtime's existing Bridge; this installer does not modify runtime source.

Device sessions last up to 30 days without sliding renewal and survive restarts
in a private SQLite database. Operators can list and revoke devices locally.
The device-scoped notification inbox records completion, failure and observed
approval events for routed requests. Notifications belong to the initiating device
or the device that first recovers a computer-created request through the verified
ownership flow; later recovery by another device does not transfer that inbox.
Push delivery is off by default;
operators may configure their own FCM sender or an explicitly trusted ABot push
gateway. Notifications are generic by default. An optional per-device encrypted
preview can show a bounded final-answer excerpt; the gateway/provider never gets
the preview key or plaintext. The app remains usable without push.
Cancellation and reconstruction of events missed while disconnected are not
implemented. Approval recovery queries current runtime state and restores scoped
live delivery; it never automatically resends an interrupted request. The relay
host is trusted and can read routed content; transport encryption is not end-to-end
encryption.

Notification metadata, pending deliveries and durable request ownership share the
private SQLite state. Upgrading migrates schema v1, v2 or v3 to v4 without replacing
paired devices. Back up the private state and matching code while stopped before
upgrading. Older binaries cannot open v4; rollback requires the matching state
backup and old code together. See [migration](docs/MIGRATION.md#durable-request-ownership-schema-upgrade)
and [notification protocol and delivery](docs/PROTOCOL.md#notifications).

## Source layout

`bin/abot-socket.mjs` is the installed entry point; `src/main.mjs` starts a
configured relay. The source modules are grouped by responsibility:

| Directory | Owns |
| --- | --- |
| `src/cli/`, `src/setup/` | Command dispatch, operator output and new-installation preparation. |
| `src/config/`, `src/deployment/` | Private configuration validation and reviewable service/proxy plans. |
| `src/auth/`, `src/pairing/` | Durable device credentials, revocation and one-use pairing/QR. |
| `src/transport/`, `src/protocol/` | HTTP/WebSocket boundary, limits and allowed client message shapes. |
| `src/relay/` | Runtime routing, correlations, request ownership and session operations. |
| `src/notifications/` | Device inbox/outbox, delivery adapters, gateway and encrypted previews. |
| `src/review/` | Separate app-review installation and protected pairing portal. |

## Local validation

From the development checkout, install the locked dependencies and run the local tests:

```sh
npm ci --omit=optional --ignore-scripts
npm test
```

Runtime dependencies are pinned `ws` for transport and `qrcode-generator` for
local pairing QR generation; the latter has no runtime dependencies. Source tests and
package-verification scripts are not shipped inside the npm consumer package.

To inspect the exact distribution files before installing a source-built package:

```sh
npm pack --ignore-scripts --json > /tmp/abot-socket-pack.json
npm run check-package -- /tmp/abot-socket-pack.json
```

The tarball contains an explicit allowlist of runtime modules and consumer docs.
Keep credentials, machine configuration, state, logs and private support reports
outside the checkout. Never attach pairing codes or QR images to a public issue.

Tests use dummy identities and mock runtime peers. The transport tests
open loopback HTTP and WebSocket listeners; they do not connect to a live runtime
or send email. Run them only in an environment permitted for that local traffic.
Passing these tests does not establish proxy correctness,
or compatibility with a separately installed client/runtime version.
