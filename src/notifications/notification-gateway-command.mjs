import { dirname, resolve } from 'node:path';
import { readPrivateConfiguration } from '../config/config.mjs';
import { createFcmProvider } from './notification-delivery-fcm.mjs';
import { createNotificationGateway } from './notification-gateway.mjs';

/** The publisher runs this separate sender with its own identity and state. */
export function loadNotificationGatewayConfiguration(path) {
  if (typeof path !== 'string' || !path) throw new Error('Provide a private gateway configuration');
  const config = readPrivateConfiguration(path);
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      Object.keys(config).some(key => !['publicOrigin', 'port', 'stateDirectory', 'serviceAccountFile'].includes(key))) {
    throw new Error('Invalid push gateway configuration');
  }
  let origin;
  try { origin = new URL(config.publicOrigin); } catch { /* Validated below. */ }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) {
    throw new Error('Gateway requires a canonical HTTPS origin');
  }
  const port = config.port ?? 8790;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway listener port');
  const directory = dirname(resolve(path));
  const privatePath = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Gateway requires private state and credential paths');
    }
    return resolve(directory, value);
  };
  return { publicOrigin: config.publicOrigin, port,
    stateDirectory: privatePath(config.stateDirectory),
    serviceAccountFile: privatePath(config.serviceAccountFile) };
}

export async function startConfiguredNotificationGateway(env, dependencies = {}) {
  const path = env.ABOT_SOCKET_CONFIG || env.SOCKET_V2_CONFIG;
  const config = loadNotificationGatewayConfiguration(path);
  const provider = (dependencies.createProvider ?? createFcmProvider)({ serviceAccountFile: config.serviceAccountFile });
  const gateway = (dependencies.createGateway ?? createNotificationGateway)({
    stateDirectory: config.stateDirectory, publicOrigin: config.publicOrigin,
    sendProviderEnvelope: (token, envelope, signal) => provider.sendEnvelope(token, envelope, signal),
  });
  try {
    await gateway.listen(config.port);
    return gateway;
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
