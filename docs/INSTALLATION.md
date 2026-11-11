# Installation and first connection

ABot Socket is MIT-licensed source; `@abot-ai/socket` is not published on npm yet.
`private: true` deliberately blocks registry publication while the first release
is prepared. This is the canonical consumer guide; use a locally prepared package
tarball until a registry release exists.

## Install the command

Use Node.js 24 or later and a persistent npm installation owned by an unprivileged
account. Linux with systemd is the server deployment target; macOS can run the
foreground service and local development checks. The authentication store uses
POSIX ownership/permissions and does not support Windows server installation.

To prepare a tarball from the public source:

```sh
git clone https://github.com/Dorshitrit/abot-socket.git
cd abot-socket
npm ci --omit=optional --ignore-scripts
npm pack --ignore-scripts --json > /tmp/abot-socket-pack.json
npm run check-package -- /tmp/abot-socket-pack.json
```

Then install that tarball (or a verified local tarball you already have):

```sh
npm install --global ./abot-ai-socket-0.1.0.tgz
abot-socket --version
abot-socket setup
```

After a public release exists, the install argument can become
`@abot-ai/socket@<released-version>`. Prefer an explicit version for server upgrades.
That registry route is not available for this candidate. An installed package
uses the `abot-socket` command; it does not require a Git checkout or `npm ci`.
Contributor commands are separate in [Self-hosting](SELF-HOSTING.md#source-checkout-development).

Do not use an ephemeral npx installation for a persistent system service. npm
installation has no lifecycle install hooks and does not run the setup wizard,
request certificates, contact your runtime or change OS service settings.

## Follow setup

The interactive wizard asks for:

1. A new private installation directory; the default is `~/.abot-socket`.
2. Your canonical HTTPS origin, for example `https://socket.example.net`.
3. The runtime identity and a private loopback listener port (default 8788).
4. On Linux as a non-root user: nginx, Apache or an existing HTTPS setup. Proxy
   templates require paths to an existing full-chain certificate and private key.
5. Confirmation before writing any installation files.

Setup creates a new directory with mode `0700` and private files with mode `0600`:

| Output | Purpose |
| --- | --- |
| `config.json` | HTTPS origin, listener port, state location and runtime grants containing token hashes. |
| `runtime-connection.json` | Bridge URL, runtime identity and secret; transfer only to the runtime computer. |
| `state/auth.sqlite3` | Pairing state, device credentials, notification metadata and pending delivery state. |
| `deployment/` | Reviewable Linux service/proxy plan, when selected in the interactive wizard. |

Setup defaults to Ask permission and port `8788`. Keep the installation outside
the package/source directory so package updates cannot replace its state.
No services are installed/started and certificate contents are never read.
Pairing details are displayed in the terminal, not stored as a plaintext file.
They expire after five minutes, so request a fresh bundle when HTTPS is ready.

The optional endpoint check at the end makes one bounded public HTTPS request only
if you explicitly choose it. A successful check proves relay health, not a working
runtime or model. Cancellation before file creation leaves no installation behind.

For unattended local file preparation, use explicit arguments instead of prompts:

```sh
abot-socket setup --output /srv/abot-private \
  --origin https://socket.example.net --runtime-id workstation --port 8788
```

The parent directory must exist, and the output directory must not exist. Run as
the same unprivileged account that will operate the relay. The unattended command
creates the configuration/state only; use `deployment` separately for service files.
If state initialization fails after files were written, preserve the installation,
correct the private-state path/permissions and use `pair` to retry. Setup never
overwrites existing configuration or state.

## Configure HTTPS and start the relay

Follow [Deployment](DEPLOYMENT.md) to review and explicitly apply the generated
systemd and proxy files. Supply DNS, a valid certificate and the required proxy
software yourself; neither npm nor setup obtains or installs them. Existing
services must be checked before applying the plan.

For foreground operation instead of a system service:

```sh
abot-socket start
```

Commands use `~/.abot-socket/config.json` by default. For a custom location:

```sh
abot-socket start --config /srv/abot-private/config.json
abot-socket check-config --config /srv/abot-private/config.json
```

`--config` overrides environment settings. Otherwise `ABOT_SOCKET_CONFIG` and its
legacy `SOCKET_V2_CONFIG` alias retain their existing precedence/conflict checks.
`setup` takes `--output` instead; it never overwrites an existing configuration.

## Connect runtime, then pair the app

Privately transfer `runtime-connection.json` to the intended runtime computer.
Configure its existing bridge with the generated `agentBridgeUrl`, `runtimeId`
and `runtimeToken`, using that runtime version's documented configuration names.
The file is a credential handoff, not a replacement runtime configuration or a
second bridge process. This is separate from app pairing; the runtime secret
must never go into the app.
No runtime source changes are required by this installer.

```sh
abot-socket doctor
abot-socket pair
```

For custom configuration locations, add `--config` to those commands as above.
Doctor verifies TLS and the `/health` response, refuses redirects and has a five-second
total timeout. Its output always includes `runtimeVerified: false`. It never sends
credentials or generates a device session. The app must confirm that the selected
runtime is online and can complete a chat request.

In a normal terminal, `abot-socket pair` also displays a private QR for a scanner-capable
ABot App. Scan inside the app, check the displayed server address, and confirm.
The QR contains the same HTTPS URL, temporary pairing key and six-digit code; it
expires after five minutes and can be used once. Anyone with the QR can use that
pending pairing, so do not publish it or send it to a public QR service.

Generate a fresh QR **after** the service and HTTPS are ready; setup does not start
the server, and its initial pairing may expire while deployment is being completed.
The QR is printed locally, not saved to disk or served at a public endpoint.
Piped output keeps the existing text/JSON format. `TERM=dumb` or a narrow terminal
uses manual details instead; widen the terminal and run `pair` again if needed.
When running a remote command through SSH, allocate a terminal to display the QR.

Manual entry remains available for app versions without a scanner or when camera
access is unavailable: enter the new code, HTTPS URL and temporary pairing key. Afterwards,
`abot-socket devices` lists devices and `abot-socket revoke <device-id>` revokes one.
Both operate on the local private state without restarting the service.

Push delivery is optional and off by default. Ordinary chat and the notification
inbox work without it. See [push delivery configuration](SELF-HOSTING.md#optional-push-delivery)
for the difference between the Store application's gateway and a self-built app's
own Firebase sender.

## Updates

Keep private configuration/state outside the npm package directory. Updating the
package must not replace that state. Regenerate the service plan if Node or the
package path changes, and restart the service explicitly during the approved update.
No automatic update, live migration or service restart is implemented here.
