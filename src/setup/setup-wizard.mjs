import { join } from 'node:path';
import { createInstallation, prepareInstallation } from './setup.mjs';
import { collectSetupAnswers, collectProxyAnswers } from './setup-questions.mjs';
import { renderDeploymentPlan, writeDeploymentPlan } from '../deployment/deployment-plan.mjs';
import { printInstallation } from '../cli/cli-output.mjs';
import { checkPublicEndpoint } from '../cli/doctor.mjs';

const confirmed = (value) => /^(y|yes)$/i.test(value.trim());

/** Every OS integration is prepared as files; only an explicit doctor answer contacts HTTPS. */
export async function runSetupWizard({ ask, out, homeDirectory, platform, username, nodePath, entryPath,
  pairingOutput = {},
  create = createInstallation, render = renderDeploymentPlan, writePlan = writeDeploymentPlan,
  checkEndpoint = checkPublicEndpoint }) {
  out('ABot Socket setup — prepare a private installation on your own server.');
  out('This wizard writes local files. It does not install dependencies, alter DNS/TLS, or activate services.');
  const options = await collectSetupAnswers({ ask, out, homeDirectory });
  let deployment;
  if (platform === 'linux' && username !== 'root') {
    const proxy = await collectProxyAnswers({ ask, out });
    deployment = { ...proxy, platform, username, nodePath, entryPath,
      configPath: join(options.output, 'config.json'), config: prepareInstallation(options).config,
      output: join(options.output, 'deployment') };
    render(deployment); // Reject unsafe deployment values before creating private state.
  } else {
    out('Linux service files require setup as an unprivileged Linux user. Foreground operation is available separately.');
  }
  out(`Installation: ${JSON.stringify(options.output)}`);
  out(`Server: ${options.origin}; runtime: ${options.runtimeId}; listener: 127.0.0.1:${options.port}`);
  out(deployment ? 'A reviewable systemd/proxy plan will also be written, without activating it.' : 'No service or proxy files will be written.');
  if (!confirmed(await ask('Create these files? [y/N]: '))) {
    out('Setup cancelled; no installation files were created.');
    return 0;
  }
  const result = create(options);
  printInstallation(result, out, pairingOutput);
  if (deployment) {
    writePlan(deployment);
    out(`Review the deployment instructions in ${JSON.stringify(deployment.output)} before applying them.`);
  }
  out('The relay is not started by setup. Connect its runtime using the private runtime-connection.json details.');
  out('After the service and HTTPS are ready, use abot-socket doctor, then abot-socket pair for fresh details.');
  if (confirmed(await ask('Check the public HTTPS endpoint now? [y/N]: '))) {
    const report = await checkEndpoint(options.origin);
    out(report.ok ? 'HTTPS relay health check passed.' : `HTTPS relay check: ${report.code}.`);
    out('Runtime connectivity is verified after pairing in the app; it was not tested by this health check.');
    return report.ok ? 0 : 1;
  }
  return 0;
}
