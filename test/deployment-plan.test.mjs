import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderDeploymentPlan, writeDeploymentPlan } from '../src/deployment/deployment-plan.mjs';

const CONFIG = {
  publicOrigin: 'https://socket.example.test:9443', port: 8788, stateDirectory: './state',
  runtimeGrants: [{ runtimeId: 'workstation', tokenSha256: 'a'.repeat(64) }],
};
const OPTIONS = {
  config: CONFIG, configPath: '/srv/abot/config.json', nodePath: '/usr/local/bin/node',
  entryPath: '/opt/abot/bin/abot-socket.mjs', username: 'abot', platform: 'linux',
  certificatePath: '/etc/tls/socket/fullchain.pem', keyPath: '/etc/tls/socket/private.key',
};

function workspace(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'abot-deployment-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'plan') };
}

test('service plan binds a persistent Node entry and private state to an unprivileged user', () => {
  const plan = renderDeploymentPlan(OPTIONS);
  const unit = plan.files['abot-socket.service'];
  assert.match(unit, /^User=abot$/m);
  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/node" "\/opt\/abot\/bin\/abot-socket.mjs" start --config "\/srv\/abot\/config.json"$/m);
  assert.match(unit, /^ReadWritePaths="\/srv\/abot\/state"$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.equal(unit.includes('MemoryDenyWriteExecute'), false);
  assert.equal(unit.includes('ExecStart=npm'), false);
  assert.equal(JSON.stringify(plan).includes(CONFIG.runtimeGrants[0].tokenSha256), false);
});

test('nginx plan preserves incoming authority and overwrites trusted proxy headers', () => {
  const proxy = renderDeploymentPlan(OPTIONS).files['nginx.conf'];
  assert.match(proxy, /listen 9443 ssl;/);
  assert.match(proxy, /server_name socket\.example\.test;/);
  assert.match(proxy, /proxy_set_header Host \$http_host;/);
  assert.equal(proxy.includes('proxy_set_header Host socket.example.test'), false);
  assert.match(proxy, /proxy_set_header X-Socket-Client-IP \$remote_addr;/);
  assert.match(proxy, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(proxy, /proxy_set_header Authorization \$http_authorization;/);
  assert.match(proxy, /proxy_set_header Origin \$http_origin;/);
  assert.match(proxy, /proxy_http_version 1\.1;/);
  assert.match(proxy, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(proxy, /ssl_certificate_key "\/etc\/tls\/socket\/private.key";/);
});

test('Apache plan preserves authority, uses the connection peer and supports WebSocket upgrade', () => {
  const plan = renderDeploymentPlan({ ...OPTIONS, proxy: 'apache' });
  const proxy = plan.files['apache.conf'];
  assert.match(proxy, /<VirtualHost \*:9443>/);
  assert.match(proxy, /ServerName socket\.example\.test:9443/);
  assert.match(proxy, /ProxyPreserveHost On/);
  assert.match(proxy, /RequestHeader set X-Socket-Client-IP "expr=%\{CONN_REMOTE_ADDR\}"/);
  assert.match(proxy, /RequestHeader unset X-Forwarded-Proto/);
  assert.match(proxy, /RequestHeader set X-Forwarded-Proto "https"/);
  assert.match(proxy, /upgrade=websocket/);
  assert.equal(proxy.includes('RequestHeader set Host'), false);
  assert.ok(plan.notes.some((note) => note.includes('2.4.47+')));
  assert.ok(plan.notes.some((note) => note.includes('Debian/Ubuntu')));
});

test('existing-proxy mode generates no TLS configuration or proxy commands', () => {
  const plan = renderDeploymentPlan({ ...OPTIONS, proxy: 'none', certificatePath: undefined, keyPath: undefined });
  assert.deepEqual(Object.keys(plan.files).sort(), ['DEPLOYMENT.txt', 'abot-socket.service']);
  assert.equal(plan.commands.length, 3);
  assert.ok(plan.notes.some((note) => note.includes('No proxy configuration')));
});

test('spaces and literal percent signs remain data in systemd and TLS path fields', () => {
  const plan = renderDeploymentPlan({ ...OPTIONS,
    configPath: '/srv/abot files/100%/config.json', nodePath: '/opt/node files/bin/node',
    certificatePath: '/etc/tls/certificate files/fullchain.pem',
  });
  const unit = plan.files['abot-socket.service'];
  assert.match(unit, /--config "\/srv\/abot files\/100%%\/config.json"/);
  assert.match(unit, /ReadWritePaths="\/srv\/abot files\/100%%\/state"/);
  assert.match(plan.files['nginx.conf'], /ssl_certificate "\/etc\/tls\/certificate files\/fullchain.pem";/);
});

test('unsafe paths, privilege choices and non-Linux targets are rejected before rendering', () => {
  for (const value of ['/srv/a\nExecStart=/bin/sh', '/srv/a"; include bad', '/srv/$HOME/key',
    '/srv/$(command)/key', '/srv/`command`/key', '/srv/a\\b/key', '/srv/../etc/key',
    '/srv//key', '/srv/key\tname', 'relative', '/']) {
    for (const field of ['configPath', 'nodePath', 'entryPath', 'certificatePath', 'keyPath']) {
      assert.throws(() => renderDeploymentPlan({ ...OPTIONS, [field]: value }), /absolute normalized path/);
    }
  }
  for (const username of ['root', 'Root', '-root', 'user\nUser=root', 'bad user']) {
    assert.throws(() => renderDeploymentPlan({ ...OPTIONS, username }));
  }
  assert.throws(() => renderDeploymentPlan({ ...OPTIONS, platform: 'darwin' }), /Linux/);
  assert.throws(() => renderDeploymentPlan({ ...OPTIONS, proxy: 'unsupported' }), /nginx, apache or none/);
  assert.throws(() => renderDeploymentPlan({ ...OPTIONS, entryPath: '/home/abot/.npm/_npx/cache/bin/socket.mjs' }), /persistently/);
  for (const field of ['configPath', 'nodePath', 'entryPath']) {
    assert.throws(() => renderDeploymentPlan({ ...OPTIONS, [field]: '/tmp/temporary-path' }), /persistent paths/);
  }
  assert.throws(() => renderDeploymentPlan({ ...OPTIONS, config: { ...CONFIG, stateDirectory: '/var/tmp/state' } }), /persistent paths/);
});

test('proxy names and authorities cannot introduce directives or route to unexpected ports', () => {
  for (const publicOrigin of ['https://bad_host.example.test', 'https://127.0.0.1',
    'https://localhost', 'https://example.test/path', 'https://example.test:70000',
    'https://example.test:0', 'https://example.test:8788',
    'https://name:pass@example.test', 'https://example.test?include=evil']) {
    assert.throws(() => renderDeploymentPlan({ ...OPTIONS, config: { ...CONFIG, publicOrigin } }));
  }
  for (const port of [80, 0, 70000, '8788; include evil']) {
    assert.throws(() => renderDeploymentPlan({ ...OPTIONS, config: { ...CONFIG, port } }));
  }
});

test('writer creates private review files without reading TLS keys or touching host destinations', (t) => {
  const { root, output } = workspace(t);
  const existing = join(root, 'existing.conf');
  fs.writeFileSync(existing, 'existing host configuration', { mode: 0o600 });
  const key = join(root, 'private.key');
  fs.writeFileSync(key, 'DUMMY_PRIVATE_CONTENT_NOT_FOR_THE_PLAN', { mode: 0o600 });
  const result = writeDeploymentPlan({ ...OPTIONS, keyPath: key, output });
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  for (const name of Object.keys(result.files)) {
    assert.equal(fs.statSync(join(output, name)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(join(output, name), 'utf8'), result.files[name]);
  }
  assert.equal(JSON.stringify(result).includes('DUMMY_PRIVATE_CONTENT_NOT_FOR_THE_PLAN'), false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing host configuration');
  assert.equal(fs.readFileSync(key, 'utf8'), 'DUMMY_PRIVATE_CONTENT_NOT_FOR_THE_PLAN');
});

test('writer refuses existing directories and symlink outputs without altering their contents', (t) => {
  const { root, output } = workspace(t);
  writeDeploymentPlan({ ...OPTIONS, output });
  const before = fs.readFileSync(join(output, 'abot-socket.service'), 'utf8');
  assert.throws(() => writeDeploymentPlan({ ...OPTIONS, username: 'other', output }));
  assert.equal(fs.readFileSync(join(output, 'abot-socket.service'), 'utf8'), before);
  const link = join(root, 'link');
  fs.symlinkSync(output, link);
  assert.throws(() => writeDeploymentPlan({ ...OPTIONS, output: link }));
  assert.equal(fs.readFileSync(join(output, 'abot-socket.service'), 'utf8'), before);
});

test('invalid plans create no output and partial writes remove only newly owned files', (t) => {
  const { root, output } = workspace(t);
  assert.throws(() => writeDeploymentPlan({ ...OPTIONS, username: 'root', output }));
  assert.equal(fs.existsSync(output), false);
  const unrelated = join(root, 'keep'); fs.writeFileSync(unrelated, 'preserve');
  const failure = new Error('Simulated partial write');
  const io = { ...fs, writeFileSync(descriptor, content) {
    fs.writeFileSync(descriptor, content.slice(0, 8)); throw failure;
  } };
  assert.throws(() => writeDeploymentPlan({ ...OPTIONS, output }, io), (error) => error === failure);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
});
