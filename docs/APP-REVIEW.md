# Preparing a dedicated app-review installation

This guide prepares renewable access to an isolated review Socket using the
ordinary app pairing protocol. It does not deploy services, configure a model,
publish a package or establish App Store readiness. Actual hosting and signed
device checks remain required. The package is still an unreleased candidate.

Apple requests full app access, necessary resources such as pairing QR codes,
and backend services that remain live during review. See the current
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#before-you-submit),
including sections 2.1 and 2.3.1. Reviewers should not have to contact the developer
for each new five-minute code.

## 1. Prepare a fresh installation

Use Node.js 24 or later and an explicitly installed candidate package. Choose a
new, private output directory outside source control. Its parent must already
exist; the output directory must not. Run setup as the account that will own and
run both processes; the private files are deliberately rejected for another owner.
Replace these reserved example origins
with the dedicated HTTPS origins you intend to operate:

```sh
abot-socket review-setup \
  --output /srv/abot-review \
  --origin https://demo.example.test \
  --runtime-id review-demo \
  --review-origin https://review.example.test \
  --port 8788 \
  --review-port 8789
```

The Socket and reviewer portal require distinct HTTPS origins and listener
ports. The default ports are 8788 and 8789. Pick unused ports if other services
share the host. These examples do not authorize or perform changes to those
services.

The command creates a separate installation rather than attaching review access
to an existing Socket:

| Output | Purpose |
| --- | --- |
| `config.json` | Configuration for the dedicated review Socket. |
| `runtime-connection.json` | Private bridge URL, runtime identity and runtime secret. |
| `state/` | Dedicated Socket database, ownership and review-installation metadata. |
| `review-portal.json` | Private portal configuration bound to this review installation. |
| `review-access.txt` | Portal URL, reviewer username and generated stable password. |

The directory is private and the credential/configuration files use mode 0600.
Console output identifies the files; do not copy their secret contents into
logs, source, screenshots or a public support page. Keep this installation's
state separate from production and from any push gateway database.

The portal verifies its fresh-installation marker and database owner as well as
the bound Socket identity: origin, state directory and runtime credentials.
Changing those identity fields makes the binding invalid. Do not edit a marker
or credential hash to attach the portal to another installation. This workflow
is not a migration or a generic pairing endpoint for an existing personal server.

## 2. Configure the review runtime and optional push

Privately transfer `runtime-connection.json` only to the dedicated runtime host.
Use that runtime's existing bridge configuration to connect it; never enter the
runtime secret into the app or disclose it to reviewers. Configure a working
model and benign sample resources on that runtime. No runtime source changes
are required by this setup.

Provide enough access to exercise the app's normal features while isolating the
review workspace from personal files, accounts, credentials and production
administration. Do not rely on a home Mac remaining awake or on a developer
manually maintaining the connection during review. Hosting, model capacity and
availability are operator responsibilities.

The app uses the same submitted binary and standard behavior. There is no
reviewer-specific client mode, fake chat implementation or hidden feature switch.
Document the normal model/tool capabilities offered by this workspace.

Remote push remains disabled unless configured deliberately. If the submitted
app offers push, configure the dedicated Socket's appropriate delivery mode and
provider/gateway through the normal configuration described in
[Self-hosting](SELF-HOSTING.md) and [Deployment](DEPLOYMENT.md#optional-notification-gateway).
Keep sender credentials and gateway configuration private. Permitted operational
changes such as notification delivery and allowed permission modes do not replace
the installation's bound identity. Restart the affected process after a deliberate
configuration change, then verify the complete signed-device flow. Setup does not
prove push delivery or provision a sender service.

## 3. Prepare separate HTTPS forwarding

Run each process behind its own HTTPS origin, forwarding only to the corresponding
loopback listener. Use valid certificates and separate proxy routes. Keep the
relay's WebSocket upgrade support; the reviewer portal is a separate HTTP service.

The direct HTTPS proxy must:

- Preserve `Host` for the intended public origin, and pass `Authorization` and
  `Origin` without rewriting their meaning.
- Remove untrusted incoming `X-Forwarded-Proto` and `X-Socket-Client-IP`, then set
  the verified HTTPS protocol and the actual connection client's IP itself.
  Never trust a client-supplied forwarding header.
- Disable caching for the reviewer portal, including authenticated pages and
  QR responses. Do not enable CDN caching for this origin.
- Disable proxy access/body/header logging and tracing for the reviewer portal.
  Ensure upstream/CDN logging cannot record credentials, generated pairing
  bundles or responses. Do not introduce secret logging in the relay either.

See [the proxy trust boundary](SELF-HOSTING.md#3-configure-https-and-the-proxy-boundary).
Additional proxies or a CDN require a separately validated trusted-peer policy;
copying their incoming IP headers is not sufficient. Configuring DNS, TLS,
firewalls, service users and process supervision is separate deployment work.
No setup command activates or reloads those components.

## 4. Start and verify deliberately

After the hosting configuration has been reviewed, run the two processes with
the same Socket configuration path, in separate supervised processes or terminals:

```sh
abot-socket start --config /srv/abot-review/config.json
```

```sh
abot-socket review-portal --config /srv/abot-review/config.json
```

The second command derives the fixed sibling `review-portal.json`; do not pass
that file as the `--config` argument. Keep the separate portal origin and port
chosen during setup.

Open the protected `/review` webpage on the portal origin using the access
details in `review-access.txt` (for example, `https://review.example.test/review`).
Generate a fresh standard QR and pair the real app. The QR
lasts five minutes and is single-use. Generating another QR replaces the pending
one, while devices already paired successfully remain authorized.

Display the webpage on another screen for camera scanning. A reviewer using one
device can instead copy the displayed six-digit code, Socket URL and temporary
pairing key into the app's normal manual flow. The QR is not an app-opening link.
The app also requires the device's own passcode or biometric authentication;
this is separate from the webpage's reviewer login and Socket pairing code.

Put actual reviewer access details only in private App Review Information in
App Store Connect. Keep the portal login usable throughout review and allow
repeat pairing without developer intervention. Monitor capacity so additional
review devices can pair; revoke only obsolete review devices deliberately.

## 5. Readiness record

Before submitting the app, verify and record:

- Both public HTTPS origins, their proxy boundaries and the protected portal
  work externally; no secret appears in caches or operational logs.
- Fresh, expired, replaced and already-used pairing codes behave correctly.
  Replacing a pending code leaves paired devices usable.
- The intended runtime is online, the configured model completes real chat
  requests, and history, attachments, tool activity and approvals work with the
  submitted app. An HTTP health check proves neither runtime nor model readiness.
- The runtime and review files are isolated from personal data, and availability
  does not depend on a home computer or developer attendance.
- Device authentication, background return, camera permissions and manual
  pairing work on the actual supported Apple devices and signed build.
- Any advertised push capability is configured and verified end to end,
  including permission denial, background delivery and authenticated tap routing.
- App privacy disclosures describe actual Socket, runtime, model-provider,
  Firebase/APNs and gateway traffic. User-controlled hosting is not a substitute
  for verifying those data flows.

No deployment, live runtime/model test, notification send, account operation or
submission is implied by this guide. Keep readiness evidence and actual access
details outside the source repository.

## 6. End or renew review access

Keep both services and the runtime available until the review and any follow-up
checks finish. Afterwards, stopping the portal prevents new reviewer pairings;
it does not revoke devices that have already paired. Inspect those devices with
`abot-socket devices --config /srv/abot-review/config.json` and revoke obsolete
ones with `abot-socket revoke <device-id> --config /srv/abot-review/config.json`.
Stop the dedicated Socket/runtime as well when the demo is no longer needed.

The reviewer password remains stable until the installation is retired. If it
needs replacement, prepare a new dedicated installation and replace the private
review instructions; do not weaken checks or reuse a production configuration.
Retiring or deleting actual hosted resources is a separate operator action.
