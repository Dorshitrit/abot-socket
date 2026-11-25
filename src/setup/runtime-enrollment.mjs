import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { digestToken } from '../auth/runtime-credentials.mjs';
import { loadConfiguration } from '../config/config.mjs';
import { validateConfiguration } from '../config/config-validation.mjs';
import { writeRuntimeEnrollment } from './runtime-enrollment-files.mjs';

export function addRuntime(options, env = process.env, io) {
  // Preserve config selection/legacy-conflict validation without opening the Auth DB.
  loadConfiguration(env);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(options.runtimeId ?? '')) throw new Error('Invalid Runtime identifier');
  if (typeof options.output !== 'string' || !options.output.trim()) throw new Error('Choose a new private output directory');
  const configPath = resolve(env.ABOT_SOCKET_CONFIG || env.SOCKET_V2_CONFIG);
  return writeRuntimeEnrollment({ configPath, directory: resolve(options.output), prepare(source) {
    const validated = validateConfiguration(source);
    if (validated.runtimeGrants.some(grant => grant.runtimeId === options.runtimeId)) {
      throw Object.assign(new Error('Runtime identifier already exists'), { code: 'runtime_id_exists' });
    }
    const runtimeToken = randomBytes(32).toString('base64url');
    const config = { ...source, runtimeGrants: [...source.runtimeGrants,
      { runtimeId: options.runtimeId, tokenSha256: digestToken(runtimeToken), allowedModes: ['ask'] }] };
    validateConfiguration(config);
    const bridge = new URL('/agent-bridge', validated.publicOrigin);
    bridge.protocol = 'wss:';
    return { config, runtimeConnection: { runtimeId: options.runtimeId, agentBridgeUrl: bridge.href, runtimeToken } };
  } }, io);
}
