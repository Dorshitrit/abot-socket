# Preparing a Linux deployment

The deployment command creates files for operator review. It does not install
packages, enable services, reload a proxy, obtain certificates or change system
configuration. The existing operating-system user and proxy remain your choice.
Begin with [Installation](INSTALLATION.md) to install the package and
prepare private state; this guide is the subsequent service/HTTPS step.

After creating the private installation, prepare a plan on the Linux host where
the package is persistently installed. Run this as the installation owner; the
optional --user value must match that current unprivileged account:

```sh
abot-socket deployment --config /srv/abot/config.json \
  --output /srv/abot/deployment-plan --user abot --proxy nginx \
  --certificate /etc/tls/socket/fullchain.pem \
  --private-key /etc/tls/socket/private.key
```

Use `--proxy apache` for Apache 2.4.47 or later. Use `--proxy none` if HTTPS is
already configured; certificate/key arguments are then unnecessary. The output
directory must not exist. Its parent must exist. Generated files use mode 0600
inside a new 0700 directory. No certificate contents or pairing secrets are read
or copied into the plan.

## Review the service

The systemd unit runs the installed Node executable and CLI directly in the
foreground. It uses the specified unprivileged user, a 0077 umask, restart on
failure, and limits persistent writes to the configured state directory.

The named user must already exist and own the private configuration/state. The
state directory must exist with mode 0700 and its files must be private. It must
be outside temporary filesystem paths. The user also needs access to the Node
and package paths; a root-only Node installation cannot serve an unprivileged
application. Do not use an `npx` cache installation for a persistent service.

The plan contains exact executable/configuration paths. Regenerate it after
changing those locations. Paths with spaces are quoted; percent signs are escaped
for systemd. Other shell/proxy metacharacters are rejected rather than interpreted.
See [systemd command syntax](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

## Review HTTPS forwarding

The proxy examples require existing certificate/key files and a DNS hostname.
They preserve the incoming Host authority, including a non-default port, so the
relay can reject unknown authorities. They preserve Origin and Authorization,
support WebSocket upgrades and overwrite the trusted client-IP/protocol headers.
The generated proxy plans cap request bodies at 4 KiB. Application limits differ
by route: push registration accepts up to 8 KiB and preview-key registration up
to 512 bytes. See [HTTP limits](PROTOCOL.md#http); a stricter proxy limit wins.
If an installation needs the full registration limit, review that proxy setting
explicitly while retaining the application's route-specific limits.

The nginx example belongs in the `http` context and uses its connection address.
Review inherited real-IP settings before use. The Apache example uses
`CONN_REMOTE_ADDR`, the actual connection peer, and requires `ssl`, `headers`,
`proxy` and `proxy_http`. Apache also needs an existing Listen directive for the
HTTPS port; the plan does not add a potentially duplicate listener.

These examples describe a direct Internet-to-local-proxy-to-relay connection.
CDN or additional proxy chains need a separate trusted-peer policy. Keep pairing
details, request bodies and Authorization headers out of inherited logging rules.

References: [nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html),
[Apache WebSocket upgrade](https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html),
[Apache header handling](https://httpd.apache.org/docs/2.4/mod/mod_headers.html),
[Apache connection address](https://httpd.apache.org/docs/current/en/expr.html).

## Apply explicitly

`DEPLOYMENT.txt` lists commands to run manually from the generated directory.
Inspect existing destination files before copying anything; these are new-install
examples, not an overwrite or migration tool. Execute one command at a time and
stop on a failure. Check the proxy configuration before reloading it. The Apache
command examples use Debian/Ubuntu conventions; other distributions differ.

The service starts separately from the HTTPS proxy. After verifying both, issue
fresh pairing details and connect the app. An HTTPS health response establishes
relay reachability; the paired app must still verify that the intended runtime
is online and can complete a chat request.

## Optional notification gateway

Users of the Store app configure their Socket to use the publisher's trusted
gateway; they do not need to host this additional process. Self-built apps can
use their own FCM sender directly. See [push delivery configuration](SELF-HOSTING.md#optional-push-delivery).

The Store application's publisher can run a separate sender process from this
package. It is distinct from a user's Socket and must have its own private state
directory, HTTPS origin and Firebase service account. Nothing in ordinary Socket
setup creates an account, starts this gateway or enables remote delivery.

Keep the gateway JSON and service-account file outside source with mode `0600`:

```json
{
  "publicOrigin": "https://push.example.invalid",
  "port": 8790,
  "stateDirectory": "./push-state",
  "serviceAccountFile": "./firebase-service-account.json"
}
```

Run `abot-socket push-gateway --config /absolute/private/gateway.json` behind a
trusted HTTPS reverse proxy. Like the Socket, it binds loopback only; the proxy
must supply the verified client address and HTTPS forwarding headers described
in this guide and allow its bounded JSON requests up to 8 KiB. Do not reuse the
Socket's authentication state directory: the gateway
has a separate database identity and rejects mixed state.

The app uses `/v1/enroll` and `/v1/confirm` to prove receipt of a short-lived
provider challenge. It receives separate device-scoped send and revoke grants,
valid for up to 30 days. Only proof of receipt can replace an existing target.
The paired Socket calls `/v1/deliver` with the send grant, fixed event kind and
opaque notification ID. The gateway accepts neither arbitrary text nor a target
token from a sender. `/v1/revoke` requires the separate management grant.

Enrollment and sending have bounded rates, record counts, request sizes and
timeouts. Provider tokens and credential hashes stay in private gateway state.
The gateway sees delivery metadata, not chat text or pairing/runtime credentials.
Data-only enrollment delivery is best effort; a delayed challenge can expire
and must be retried while the app is open. Production deployment and a real
signed-device test remain separate from local mocked validation.
