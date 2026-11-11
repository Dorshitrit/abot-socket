export const USAGE = `ABot Socket — self-hosted relay

abot-socket setup
  Interactive local setup wizard. Requires a terminal; never configures services automatically.
abot-socket setup --output <new-directory> --origin <https-origin> --runtime-id <id> [--port 8788]
abot-socket review-setup --output <new-directory> --origin <socket-https-origin> --runtime-id <id>
  --review-origin <separate-https-origin> [--port 8788] [--review-port 8789]
abot-socket review-portal --config <demo-directory/config.json>
abot-socket start
abot-socket check-config
abot-socket doctor
abot-socket pair
abot-socket devices
abot-socket revoke <device-id>
abot-socket deployment --output <new-directory> --proxy nginx|apache|none [--user <current-user>]
  [--certificate <absolute-fullchain-path> --private-key <absolute-key-path>]

Use --config <file> with any command except setup and review-setup. Otherwise use ABOT_SOCKET_CONFIG,
the legacy SOCKET_V2_CONFIG alias, or ~/.abot-socket/config.json.

Setup creates private files and one-time pairing details. Pair replaces only the
pending pairing. Device credentials remain valid for up to 30 days across restarts.
Setup and pair show a private QR in a capable terminal; manual details remain available.
The QR expires after five minutes and can be used once. Piped output stays text/JSON.
Doctor makes one public HTTPS request to your configured /health endpoint; it does
not verify a runtime or send authentication credentials. Start runs in foreground.
Deployment only writes reviewable Linux systemd/proxy files and instructions. It
does not install packages, obtain certificates, run sudo, or activate a service.
Runtime secrets belong only on the runtime computer, never in the mobile app.
Review setup creates a new isolated Socket identity and private review-access.txt;
it never adds a portal to an existing installation or starts a runtime/service.
Use a separate demo runtime with synthetic data. Reviewer credentials stay local;
the protected portal generates fresh standard pairing details when requested.
`;
