# Self-hosting ABot Socket

Use [Installation and first connection](INSTALLATION.md) for the consumer
installation, setup and QR/manual pairing flow. This companion guide covers
configuration, the proxy trust boundary and ongoing operation. Service/proxy plan
generation is covered in [Deployment](DEPLOYMENT.md). The source is MIT-licensed;
the package is distributed as `@abot-ai/socket` on npm.

## Requirements

- Node.js 24 or later. npm installs the package's pinned dependencies, `ws` and
  `qrcode-generator`, with either the registry package or a local tarball.
- A server you control and a canonical HTTPS origin such as
  `https://socket.example.net`.
- A local HTTPS reverse proxy satisfying the boundary below.
- An ABot Runtime with its existing agent-bridge adapter, and ABot App with pairing.

There is no public signup. Every paired device acts as this installation's single
owner and can see all runtimes granted to that installation.

## 1. Prepare a private installation

Follow the [setup steps](INSTALLATION.md#follow-setup) as the unprivileged account
that will run the relay. Use your own HTTPS origin and keep the configuration,
runtime connection file and state outside the installed package directory.
Setup creates files only; applying a deployment plan and configuring the runtime
remain separate operator actions.

## 2. Check configuration and issue fresh pairing details

For an installation outside the default `~/.abot-socket` directory:

```sh
abot-socket check-config --config /srv/abot-private/config.json
abot-socket pair --config /srv/abot-private/config.json
```

`stateDirectory` is resolved relative to the configuration file, independent of
the process working directory. An explicit `--config` takes precedence over
environment settings. Otherwise use `ABOT_SOCKET_CONFIG`; `SOCKET_V2_CONFIG`
remains a legacy alias and conflicting environment values are rejected.
No mail credential is used.

`check-config` validates the file without opening listeners or state. `pair`
updates only local authentication state: it replaces any unused pairing details
and displays a new five-minute bundle. Already paired devices stay connected.
The running server sees these changes without a restart. Local operator commands
must run as the same operating-system user that owns the private state directory.
Generate pairing details after HTTPS is ready, then follow the
[QR/manual pairing flow](INSTALLATION.md#connect-runtime-then-pair-the-app).

## 3. Configure HTTPS and the proxy boundary

The application listens only on `127.0.0.1` at the configured port. Keep the proxy
on the same host and the application listener private. Containers, remote proxies,
and additional proxy chains require a separately validated network arrangement;
this package does not ship a Docker deployment.

For direct Internet-to-proxy-to-relay deployment, the proxy must:

1. Accept only the configured HTTPS authority and a valid certificate; preserve
   the exact configured Host, including a non-default port if one is configured.
2. Support WebSocket upgrades on `/v2/realtime` and `/agent-bridge`, retaining the
   `Authorization` header.
3. Remove incoming `X-Forwarded-Proto` and `X-Socket-Client-IP` values and set its
   own: `https` for the verified HTTPS request and the actual client IP observed
   on the proxy's connection. Never copy a client-supplied forwarding header.
4. Preserve an incoming browser `Origin` so the relay can reject an origin that
   differs from its configured public origin.
5. Enforce connection, request-body, and timeout limits. Keep credentials, pairing
   codes, request bodies, and authorization headers out of logs.

If a CDN or another proxy sits in front, deriving the client IP requires an
explicit trusted-peer policy. Trusting its claimed IP header from arbitrary
Internet peers is unsafe. The direct-proxy instructions above do not configure
that extra trust chain.

## 4. Start and connect

Use the [foreground or Linux service instructions](INSTALLATION.md#configure-https-and-start-the-relay),
then [connect the runtime and pair the app](INSTALLATION.md#connect-runtime-then-pair-the-app).
The app binds its device credential to the exact HTTPS origin and stores it in
the platform's protected credential storage. It does not follow authentication
or WebSocket redirects. A new server requires a new pairing; credentials are
never silently copied across hosts.

## Optional push delivery

Push is disabled by default. To enable it, the operator adds
`notifications.delivery` to the private Socket configuration and restarts the
relay deliberately:

- A self-built app uses its own Firebase project and
  `{ "type": "fcm", "serviceAccountFile": "./private-sender.json" }`.
  The app and sender must belong to the same Firebase project. Keep the service
  account on the server, owned by the service user with mode `0600`; a relative
  path is resolved from the Socket configuration file.
- A Store build uses its publisher's trusted gateway with
  `{ "type": "gateway", "gatewayOrigin": "https://<trusted-host>" }`.
  Obtain that origin from the publisher's instructions. The publisher operates
  the gateway and Firebase credentials; each user operates their own Socket.
  Do not enter provider credentials into the app or run a second gateway merely
  to use the Store build.

After server configuration, enable notifications in the app and grant platform
permission. Gateway builds enroll their own endpoint before registering it with
the paired Socket. A mismatched delivery mode is rejected; the app cannot replace
the operator's gateway URL. See [the notification protocol](PROTOCOL.md#notifications)
for device ownership, retention, delivery limitations and optional encrypted
answer previews. Gateway operation is separately described in
[Deployment](DEPLOYMENT.md#optional-notification-gateway).

## Operation and recovery

```sh
abot-socket devices --config /srv/abot-private/config.json
abot-socket revoke <device-id> --config /srv/abot-private/config.json
```

The device list contains names, identifiers and expiry, never tokens. Revocation
also closes an already-open client WebSocket within the next validity sweep
(approximately one second). At 10 active devices, revoke an unused device before
pairing another. The server never silently evicts an existing device.

Sessions have a fixed maximum lifetime of 30 days and survive server restarts.
After expiry, pair again. Reinstalling the app may require pairing again depending
on the platform's secure-storage lifecycle; retaining the device's credential is
not a guarantee across uninstall, signing or bundle-ID changes.

Back up the private configuration, runtime credential and state directory using
a consistent filesystem/database snapshot or with the service stopped. Losing
state requires pairing devices again. Restoring an old backup may restore old
revocation state; reapply necessary revocations. Conversation history remains in
each runtime. Temporary relay routes do not survive restart, so reconcile
interrupted requests with runtime history rather than automatically resending.

The package does not provision a public TLS endpoint or install a service.
Real-device, proxy and runtime verification remains separate from automated tests.

## Source-checkout development

These contributor commands require the repository checkout containing
`package.json`, `package-lock.json` and the source tests. They are not additional
steps for an installed npm/tarball consumer:

```sh
npm ci --omit=optional --ignore-scripts
npm test
```

To prepare a separate local development installation from that checkout, use
`node bin/abot-socket.mjs setup` and the same [installation guide](INSTALLATION.md).
Keep its private files outside source control. Tests use dummy identities and
loopback fixtures; they do not establish live runtime, phone or proxy readiness.
