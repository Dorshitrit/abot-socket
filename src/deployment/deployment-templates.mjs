import { posix } from 'node:path';
import { proxyQuoted, systemdQuoted } from './deployment-input.mjs';

export function renderSystemdService(input) {
  return `[Unit]
Description=ABot Socket relay
After=network.target

[Service]
Type=simple
User=${input.username}
WorkingDirectory=${systemdQuoted(posix.dirname(input.configPath))}
ExecStart=${systemdQuoted(input.nodePath)} ${systemdQuoted(input.entryPath)} start --config ${systemdQuoted(input.configPath)}
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${systemdQuoted(input.statePath)}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

export function renderNginxProxy(input) {
  return `# Include inside nginx's http context. Existing TLS files are required.
# Review global real_ip/CDN configuration before using this direct-proxy plan.
server {
    listen ${input.httpsPort} ssl;
    server_name ${input.hostname};
    ssl_certificate ${proxyQuoted(input.certificatePath)};
    ssl_certificate_key ${proxyQuoted(input.keyPath)};
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 4k;
    client_body_timeout 15s;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:${input.config.port};
        proxy_http_version 1.1;
        # Preserve the real authority, including any explicit port. The relay
        # rejects an unknown Host; never replace it with a configured constant.
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Socket-Client-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 5s;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
        proxy_buffering off;
    }
}
`;
}

export function renderApacheProxy(input) {
  return `# Apache 2.4.47+; enable ssl, headers, proxy and proxy_http modules.
# Add a matching Listen directive only if this HTTPS port is not already active.
# This direct-proxy plan uses the actual connection peer, not forwarded headers.
<VirtualHost *:${input.httpsPort}>
    ServerName ${input.authority}
    SSLEngine on
    SSLCertificateFile ${proxyQuoted(input.certificatePath)}
    SSLCertificateKeyFile ${proxyQuoted(input.keyPath)}
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    ProxyRequests Off
    ProxyPreserveHost On
    ProxyTimeout 90
    LimitRequestBody 4096

    RequestHeader unset X-Forwarded-Proto
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader unset X-Socket-Client-IP
    RequestHeader set X-Socket-Client-IP "expr=%{CONN_REMOTE_ADDR}"
    # Host, Authorization and Origin are forwarded unchanged. Unknown Host
    # values reach the relay unchanged and are rejected by its authority check.
    ProxyPass "/" "http://127.0.0.1:${input.config.port}/" upgrade=websocket connectiontimeout=5 timeout=90
    ProxyPassReverse "/" "http://127.0.0.1:${input.config.port}/"
</VirtualHost>
`;
}

export function deploymentCommands(proxy) {
  const commands = [
    'sudo install -m 0644 -- ./abot-socket.service /etc/systemd/system/abot-socket.service',
    'sudo systemctl daemon-reload',
    'sudo systemctl enable --now abot-socket.service',
  ];
  if (proxy === 'none') return commands;
  if (proxy === 'nginx') return [...commands,
    'sudo install -m 0644 -- ./nginx.conf /etc/nginx/conf.d/abot-socket.conf',
    'sudo nginx -t',
    'sudo systemctl reload nginx',
  ];
  return [...commands,
    'sudo install -m 0644 -- ./apache.conf /etc/apache2/sites-available/abot-socket.conf',
    'sudo a2enmod ssl headers proxy proxy_http',
    'sudo a2ensite abot-socket.conf',
    'sudo apachectl configtest',
    'sudo systemctl reload apache2',
  ];
}
