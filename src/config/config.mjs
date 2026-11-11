import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { validateConfiguration } from './config-validation.mjs';
import { dirname, resolve } from 'node:path';

const MAX_CONFIG_BYTES = 32_768;

function selectEnvironmentValue(env, primary, legacy) {
  const preferred = env[primary];
  const fallback = env[legacy];
  if (preferred && fallback && preferred !== fallback) {
    throw new Error(`Conflicting ${primary} and ${legacy} settings`);
  }
  const value = preferred || fallback;
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid ${primary} setting`);
  }
  return value;
}

function isPrivateConfigurationFile(stat) {
  if (!stat.isFile()) return false;
  if (stat.size > MAX_CONFIG_BYTES) return false;
  return (stat.mode & 0o077) === 0;
}

export function readPrivateConfiguration(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!isPrivateConfigurationFile(fstatSync(descriptor))) throw new Error();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_CONFIG_BYTES) throw new Error();
    return JSON.parse(buffer.toString('utf8', 0, bytes));
  } catch {
    // Filesystem and JSON errors may contain paths or configuration values.
    throw new Error('Configuration must be a small private file with mode 0600 and valid JSON');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadConfiguration(env = process.env) {
  const path = selectEnvironmentValue(env, 'ABOT_SOCKET_CONFIG', 'SOCKET_V2_CONFIG');
  if (!path) throw new Error('Set ABOT_SOCKET_CONFIG to a private JSON configuration file');
  const config = validateConfiguration(readPrivateConfiguration(path));
  const delivery = config.notifications.delivery;
  if (delivery.type === 'fcm') {
    delivery.serviceAccountFile = resolve(dirname(resolve(path)), delivery.serviceAccountFile);
  }
  return { ...config, stateDirectory: resolve(dirname(resolve(path)), config.stateDirectory) };
}
