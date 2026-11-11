import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { defaultInstallationDirectory } from '../cli/cli-environment.mjs';
import { validateConfiguration } from '../config/config-validation.mjs';

const fixtureGrant = [{ runtimeId: 'workstation', tokenSha256: '0'.repeat(64) }];

export async function askValidated(ask, out, prompt, fallback, validate) {
  while (true) {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await ask(`${prompt}${suffix}: `)).trim() || fallback;
    try { return validate(answer); }
    catch { out(`Invalid ${prompt.toLowerCase()}. Please try again.`); }
  }
}

export function validateSetupDirectory(value) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Choose an output directory');
  const path = resolve(value);
  if (existsSync(path)) throw new Error('The output directory must be new');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The parent must be an existing directory');
  return path;
}

function validateAnswer(field, value) {
  const baseline = { publicOrigin: 'https://socket.example.invalid', stateDirectory: './state', runtimeGrants: fixtureGrant };
  const candidate = field === 'runtimeId'
    ? { ...baseline, runtimeGrants: [{ ...fixtureGrant[0], runtimeId: value }] }
    : { ...baseline, [field]: value };
  validateConfiguration(candidate);
  return value;
}

export async function collectSetupAnswers({ ask, out, homeDirectory }) {
  const output = await askValidated(ask, out, 'New private installation directory',
    defaultInstallationDirectory(homeDirectory), validateSetupDirectory);
  const origin = await askValidated(ask, out, 'HTTPS server origin', '', (value) => validateAnswer('publicOrigin', value));
  const runtimeId = await askValidated(ask, out, 'Runtime identifier', 'workstation', (value) => validateAnswer('runtimeId', value));
  const port = await askValidated(ask, out, 'Local listener port', '8788', (value) => {
    if (!/^\d{4,5}$/.test(value)) throw new Error('Invalid port');
    return validateAnswer('port', Number(value));
  });
  return { output, origin, runtimeId, port };
}

export async function collectProxyAnswers({ ask, out }) {
  const proxy = await askValidated(ask, out, 'HTTPS proxy (nginx, apache, or none for existing setup)', 'none', (value) => {
    if (!['nginx', 'apache', 'none'].includes(value)) throw new Error('Unknown proxy');
    return value;
  });
  if (proxy === 'none') return { proxy };
  out('The following paths refer to your existing TLS certificate and key; their contents are never copied.');
  const certificatePath = await askValidated(ask, out, 'Full-chain certificate path', '', validateCertificatePath);
  const keyPath = await askValidated(ask, out, 'TLS private key path', '', validateCertificatePath);
  return { proxy, certificatePath, keyPath };
}

function validateCertificatePath(value) {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('An absolute path is required');
  return value;
}
