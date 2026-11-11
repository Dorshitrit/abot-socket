import { posix } from 'node:path';
import { validateConfiguration } from '../config/config-validation.mjs';

function requireLinuxPlatform(platform) {
  if (platform !== 'linux') throw new Error('Deployment plans target Linux with systemd only');
}

function requireServiceUsername(username) {
  if (typeof username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
    throw new Error('Choose an unprivileged Linux service username');
  }
  if (username === 'root') throw new Error('The relay service must not run as root');
  return username;
}

function requireDeploymentPath(value, label) {
  // Spaces and percent signs are handled by each target syntax. Other shell,
  // proxy-variable and control characters are deliberately unsupported.
  if (typeof value !== 'string' || value.length > 4096 ||
      !/^\/[A-Za-z0-9_./ %+-]+$/.test(value) || value === '/' ||
      posix.normalize(value) !== value || value.endsWith('/')) {
    throw new Error(`${label} requires an absolute normalized path containing letters, numbers, spaces, . _ - + or %`);
  }
  return value;
}

function requireProxyHost(origin) {
  const labels = origin.hostname.split('.');
  if (origin.hostname.length > 253 || labels.length < 2 ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('HTTPS deployment requires a canonical DNS hostname');
  }
  if (labels.every((label) => /^\d+$/.test(label))) {
    throw new Error('HTTPS deployment requires a DNS hostname, not an IP address');
  }
}

function requireHttpsListenerPort(origin, relayPort) {
  const port = origin.port ? Number(origin.port) : 443;
  if (port < 1 || port > 65535) throw new Error('HTTPS requires a valid listener port');
  if (port === relayPort) throw new Error('HTTPS and the private relay require different listener ports');
  return port;
}

function requirePersistentServicePath(path) {
  const temporaryRoots = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];
  if (temporaryRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error('The system service requires persistent paths outside temporary storage');
  }
}

export function validateDeploymentInput(options) {
  requireLinuxPlatform(options.platform ?? 'linux');
  const config = validateConfiguration(options.config);
  const origin = new URL(config.publicOrigin);
  requireProxyHost(origin);
  const proxy = options.proxy ?? 'nginx';
  if (!['nginx', 'apache', 'none'].includes(proxy)) throw new Error('Choose nginx, apache or none for the HTTPS plan');
  const configPath = requireDeploymentPath(options.configPath, 'Configuration');
  const statePath = requireDeploymentPath(posix.resolve(posix.dirname(configPath), config.stateDirectory), 'State directory');
  const nodePath = requireDeploymentPath(options.nodePath, 'Node executable');
  const entryPath = requireDeploymentPath(options.entryPath, 'Installed command');
  for (const path of [configPath, statePath, nodePath, entryPath]) requirePersistentServicePath(path);
  if (entryPath.includes('/_npx/')) throw new Error('Install the package persistently before preparing a service');
  return {
    config, configPath, statePath, nodePath, entryPath, proxy,
    username: requireServiceUsername(options.username),
    certificatePath: proxy === 'none' ? undefined : requireDeploymentPath(options.certificatePath, 'TLS certificate'),
    keyPath: proxy === 'none' ? undefined : requireDeploymentPath(options.keyPath, 'TLS private key'),
    hostname: origin.hostname, authority: origin.host,
    httpsPort: requireHttpsListenerPort(origin, config.port),
  };
}

export const systemdQuoted = (value) => `"${value.replaceAll('%', '%%')}"`;
export const proxyQuoted = (value) => `"${value}"`;
