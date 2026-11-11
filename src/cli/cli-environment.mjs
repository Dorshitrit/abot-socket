import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultInstallationDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, '.abot-socket');
}

/** An explicit CLI config wins; otherwise preserve the existing environment contract. */
export function resolveCliInvocation(args, env = process.env, homeDirectory = homedir()) {
  const remaining = [];
  let explicitConfig;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--config') { remaining.push(args[index]); continue; }
    const value = args[++index];
    if (explicitConfig !== undefined || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error('Provide --config once with a file path');
    }
    explicitConfig = resolve(value);
  }
  if (explicitConfig !== undefined && ['setup', 'review-setup'].includes(remaining[0])) {
    throw new Error('Setup uses --output for a new installation; --config selects an existing installation');
  }
  const selected = { ...env };
  if (explicitConfig !== undefined) {
    selected.ABOT_SOCKET_CONFIG = explicitConfig;
    delete selected.SOCKET_V2_CONFIG;
  } else if (!selected.ABOT_SOCKET_CONFIG && !selected.SOCKET_V2_CONFIG) {
    selected.ABOT_SOCKET_CONFIG = join(defaultInstallationDirectory(homeDirectory), 'config.json');
  }
  return { command: remaining[0], args: remaining.slice(1), env: selected };
}
