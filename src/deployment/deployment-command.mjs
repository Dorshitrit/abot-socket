import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfiguration } from '../config/config.mjs';
import { writeDeploymentPlan } from './deployment-plan.mjs';

const flags = new Map([['--output', 'output'], ['--proxy', 'proxy'], ['--user', 'username'],
  ['--certificate', 'certificatePath'], ['--private-key', 'keyPath']]);

export function parseDeploymentArguments(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = flags.get(args[i]);
    const value = args[i + 1];
    if (!name || Object.hasOwn(result, name) || !value || value.startsWith('--')) {
      throw new Error('Invalid deployment options');
    }
    result[name] = value;
  }
  if (!result.output || !result.proxy) throw new Error('Deployment requires output and proxy selection');
  result.output = resolve(result.output);
  return result;
}

export function deploymentRuntimePaths() {
  return { nodePath: realpathSync(process.execPath),
    entryPath: fileURLToPath(new URL('../../bin/abot-socket.mjs', import.meta.url)) };
}

export function prepareDeployment(args, { env, out, platform = process.platform, username = userInfo().username }) {
  const options = parseDeploymentArguments(args);
  if (options.username && options.username !== username) {
    throw new Error('Generate deployment files as the installation owner');
  }
  const config = loadConfiguration(env);
  const output = writeDeploymentPlan({ ...options, ...deploymentRuntimePaths(), config,
    configPath: resolve(env.ABOT_SOCKET_CONFIG || env.SOCKET_V2_CONFIG), platform, username });
  out(`Deployment files prepared in ${JSON.stringify(options.output)}. Review the instructions before applying them.`);
  out('No service, certificate, proxy configuration or package was installed.');
  return output;
}
