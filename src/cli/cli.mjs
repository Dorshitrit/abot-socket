import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallation } from '../setup/setup.mjs';
import { parseSetupArguments } from './cli-arguments.mjs';
import { loadConfiguration } from '../config/config.mjs';
import { AuthService } from '../auth/auth.mjs';
import { USAGE } from './cli-help.mjs';
import { printInstallation, printPairing } from './cli-output.mjs';
import { createReviewDemoInstallation, parseReviewDemoArguments } from '../review/review-demo-setup.mjs';

export function runCli(args, { env = process.env, out = console.log, error = console.error, pairingOutput = {} } = {}) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') { out(USAGE); return 0; }
  try {
    if (command === 'review-setup') {
      const result = createReviewDemoInstallation(parseReviewDemoArguments(rest));
      out(`Created isolated review demo files in ${JSON.stringify(result.directory)}.`);
      out(`Socket and portal configuration: ${JSON.stringify(result.configPath)}`);
      out(`Private reviewer credentials: ${JSON.stringify(result.reviewAccessPath)}`);
      out(`Demo runtime connection: ${JSON.stringify(result.runtimeConnectionPath)}`);
      out('No service or runtime was started. Use a separate runtime workspace containing only synthetic data.');
      return 0;
    }
    if (command === 'setup') {
      const result = createInstallation(parseSetupArguments(rest));
      printInstallation(result, out, pairingOutput);
      return 0;
    }
    if (command === 'check-config' && rest.length === 0) {
      loadConfiguration(env);
      out('Configuration is valid locally. HTTPS, state storage and runtime reachability were not tested.');
      return 0;
    }
    if (['pair', 'devices'].includes(command) && rest.length === 0 ||
        command === 'revoke' && rest.length === 1 && /^[A-Za-z0-9_-]{16,128}$/.test(rest[0])) {
      const config = loadConfiguration(env);
      const auth = new AuthService({ stateDirectory: config.stateDirectory });
      try {
        if (command === 'pair') printPairing({ serverUrl: config.publicOrigin, ...auth.createPairing() }, out, pairingOutput);
        if (command === 'devices') out(JSON.stringify({ devices: auth.listDevices() }, null, 2));
        if (command === 'revoke') out(JSON.stringify({ revoked: auth.revokeDevice(rest[0]) }));
      } finally { auth.close(); }
      return 0;
    }
    error('Unknown command or arguments. Run with --help.');
    return 2;
  } catch {
    // Never echo provider, filesystem or parser error values into operator logs.
    error(command === 'setup'
      ? 'Setup failed. Check arguments and private output/state permissions. If installation files exist, use pair to retry without overwriting them.'
      : 'Command failed. Check the private configuration, state permissions, HTTPS origin and runtime grants.');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2));
}
