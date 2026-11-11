import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { validateDeploymentInput } from './deployment-input.mjs';
import { deploymentCommands, renderApacheProxy, renderNginxProxy, renderSystemdService } from './deployment-templates.mjs';

export function renderDeploymentPlan(options) {
  const input = validateDeploymentInput(options);
  const notes = [
    'This is a reviewable Linux deployment plan. No service, proxy, certificate or system setting has been changed.',
    'Run the listed commands manually from the generated directory, one at a time; stop if any command fails.',
    'Inspect existing destination files before copying; these sample commands are for a new installation, not an automatic update.',
    `The existing unprivileged service user must be ${input.username} and must own the private configuration and state directory.`,
    'The service user needs execute/read access to the installed Node and package paths. Do not use an npx cache path.',
    'State must already exist with mode 0700, and its database/configuration files must remain 0600. Persistent writes are limited to that directory.',
    'TLS certificate/key files, DNS and firewall access must be configured separately. This plan never requests or copies a private key.',
    'Use a local direct HTTPS proxy. CDN or additional proxy chains require a separately reviewed trusted-client-IP policy.',
    'Keep request bodies, pairing details and Authorization headers out of proxy logs; review inherited logging settings.',
    'Regenerate the plan if the Node executable, package installation or private configuration location changes.',
    'After service and HTTPS checks pass, run the pairing command for fresh credentials; these files contain no pairing code.',
  ];
  if (input.proxy === 'apache') notes.push(
    'The Apache command paths target Debian/Ubuntu. Other distributions require their local module/site and service commands.',
    'Apache requires version 2.4.47+ and an existing Listen directive for the HTTPS port; do not add a duplicate listener.',
  );
  if (input.proxy === 'none') notes.push(
    'No proxy configuration was generated. Your existing HTTPS proxy must satisfy the documented Host, trusted-IP and WebSocket forwarding contract.',
  );
  const commands = deploymentCommands(input.proxy);
  const files = {
    'abot-socket.service': renderSystemdService(input),
    'DEPLOYMENT.txt': [...notes, '', 'Review and run individually:', ...commands, ''].join('\n'),
  };
  if (input.proxy === 'nginx') files['nginx.conf'] = renderNginxProxy(input);
  if (input.proxy === 'apache') files['apache.conf'] = renderApacheProxy(input);
  return { files, notes, commands };
}

/** Only writes a new operator-selected directory. Never executes plan commands. */
export function writeDeploymentPlan({ output, ...options }, io = fs) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Choose a new deployment output directory');
  const plan = renderDeploymentPlan(options);
  const directory = resolve(output);
  io.mkdirSync(directory, { mode: 0o700 });
  const created = [];
  try {
    for (const [name, content] of Object.entries(plan.files)) {
      const path = join(directory, name);
      const descriptor = io.openSync(path, 'wx', 0o600);
      created.push(path);
      try { io.writeFileSync(descriptor, content); } finally { io.closeSync(descriptor); }
    }
  } catch (error) {
    const failures = [];
    for (const path of created.reverse()) {
      try { io.unlinkSync(path); } catch (failure) { failures.push(failure); }
    }
    try { io.rmdirSync(directory); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Deployment write failed and cleanup was incomplete');
    throw error;
  }
  return { directory, ...plan };
}
