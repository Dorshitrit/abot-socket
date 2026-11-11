import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli.mjs';
import { resolveCliInvocation } from './cli-environment.mjs';
import { runSetupWizard } from '../setup/setup-wizard.mjs';
import { deploymentRuntimePaths, prepareDeployment } from '../deployment/deployment-command.mjs';
import { loadConfiguration } from '../config/config.mjs';
import { checkPublicEndpoint } from './doctor.mjs';
import { startConfiguredServer } from '../main.mjs';
import { startConfiguredNotificationGateway } from '../notifications/notification-gateway-command.mjs';
import { startConfiguredReviewPortal } from '../review/review-portal-server.mjs';

async function startForeground(env, out) {
  const app = await startConfiguredServer(env);
  out('ABot Socket listening on private loopback behind the configured HTTPS proxy.');
  const stop = () => { void app.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return 0;
}

async function interactiveSetup({ input, output, out, homeDirectory, pairingOutput }) {
  if (!input.isTTY || !output.isTTY) {
    out('Interactive setup requires a terminal. Use setup --output <new-directory> --origin <https-origin> --runtime-id <id>.');
    return 2;
  }
  const readline = createInterface({ input, output });
  const abort = new AbortController();
  readline.once('SIGINT', () => abort.abort());
  readline.once('close', () => abort.abort());
  try {
    return await runSetupWizard({ ask: (prompt) => readline.question(prompt, { signal: abort.signal }),
      out, homeDirectory, pairingOutput, platform: process.platform, username: userInfo().username, ...deploymentRuntimePaths() });
  } finally { readline.close(); }
}

export async function runEntry(args, { env = process.env, input = process.stdin, output = process.stdout,
  error = console.error, homeDirectory = homedir() } = {}) {
  const out = (line) => output.write(`${line}\n`);
  const pairingOutput = { isTTY: output.isTTY === true, columns: output.columns, term: env.TERM };
  try {
    const invocation = resolveCliInvocation(args, env, homeDirectory);
    const { command, args: rest } = invocation;
    if (command === '--version' && rest.length === 0) {
      const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      out(`ABot Socket ${metadata.version}`);
      return 0;
    }
    if (command === 'setup' && rest.length === 0) return await interactiveSetup({ input, output, out, homeDirectory, pairingOutput });
    if (command === 'start' && rest.length === 0) return await startForeground(invocation.env, out);
    if (command === 'review-portal' && rest.length === 0) {
      const portal = await startConfiguredReviewPortal(invocation.env);
      out('ABot review portal listening on private loopback behind its separate HTTPS proxy.');
      const stop = () => { void portal.close(); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return 0;
    }
    if (command === 'push-gateway' && rest.length === 0) {
      const gateway = await startConfiguredNotificationGateway(invocation.env);
      out('ABot notification gateway listening on private loopback behind the configured HTTPS proxy.');
      const stop = () => { void gateway.close(); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return 0;
    }
    if (command === 'doctor' && rest.length === 0) {
      const config = loadConfiguration(invocation.env);
      const report = await checkPublicEndpoint(config.publicOrigin);
      out(JSON.stringify(report));
      out('Runtime connectivity is not established by /health; verify it in the paired app.');
      return report.ok ? 0 : 1;
    }
    if (command === 'deployment') {
      prepareDeployment(rest, { env: invocation.env, out });
      return 0;
    }
    return runCli([command, ...rest], { env: invocation.env, out, error, pairingOutput });
  } catch {
    error('Command could not complete. Check arguments, private paths and platform requirements; existing installation files are preserved.');
    return 1;
  }
}
