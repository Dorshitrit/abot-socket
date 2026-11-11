import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { digestToken } from '../auth/runtime-credentials.mjs';
import { validateConfiguration } from '../config/config-validation.mjs';
import { writePrivateInstallation } from './setup-files.mjs';
import { AuthService } from '../auth/auth.mjs';

export function prepareInstallation(options) {
  const runtimeToken = randomBytes(32).toString('base64url');
  const config = validateConfiguration({
    publicOrigin: options.origin,
    port: options.port ?? 8788,
    stateDirectory: './state',
    runtimeGrants: [{ runtimeId: options.runtimeId, tokenSha256: digestToken(runtimeToken),
      allowedModes: ['ask'] }],
  });
  const bridge = new URL('/agent-bridge', config.publicOrigin);
  bridge.protocol = 'wss:';
  return {
    config,
    runtimeConnection: { runtimeId: config.runtimeGrants[0].runtimeId,
      agentBridgeUrl: bridge.href, runtimeToken },
  };
}

// Local operator only. No files, accounts, servers, or mail are modified elsewhere.
export function createInstallation(options) {
  if (typeof options.output !== 'string' || !options.output.trim()) {
    throw new Error('Choose a new private output directory');
  }
  const bundle = prepareInstallation(options);
  const directory = resolve(options.output);
  writePrivateInstallation(directory, bundle);
  // A failed state initialization leaves the private installation intact for
  // operator diagnosis; a later `pair` command can issue its first pairing.
  const auth = new AuthService({ stateDirectory: join(directory, 'state') });
  let pairing;
  try { pairing = auth.createPairing(); } finally { auth.close(); }
  return { directory, configPath: join(directory, 'config.json'),
    runtimeConnectionPath: join(directory, 'runtime-connection.json'),
    pairing: { serverUrl: bundle.config.publicOrigin, ...pairing } };
}
