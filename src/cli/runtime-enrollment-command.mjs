import { addRuntime } from '../setup/runtime-enrollment.mjs';

function parseRuntimeEnrollment(args) {
  const options = {};
  const names = new Map([['--runtime-id', 'runtimeId'], ['--output', 'output']]);
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    const value = args[index + 1];
    if (!name || Object.hasOwn(options, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error('Invalid add-runtime arguments');
    }
    options[name] = value;
  }
  if (!options.runtimeId || !options.output) throw new Error('Missing add-runtime arguments');
  return options;
}

export function runRuntimeEnrollment(args, { env, out, error }) {
  try {
    const result = addRuntime(parseRuntimeEnrollment(args), env);
    out(`Added Runtime ${JSON.stringify(result.runtimeId)} with ask permission.`);
    out(`Private connection file: ${JSON.stringify(result.runtimeConnectionPath)}`);
    out('Existing computers and phone pairings were preserved. No service was started or restarted.');
    out('Restart the configured Socket service deliberately to load the new grant, then import the private connection file on the new computer.');
    return 0;
  } catch (failure) {
    if (failure.code === 'runtime_id_exists') {
      error('That Runtime ID already exists. Choose a different ID; existing grants were not changed.');
      return 1;
    }
    if (failure.code === 'enrollment_committed_unconfirmed') {
      error('The Runtime grant was added, but durability could not be confirmed. Keep the private connection file and verify the configuration before restarting.');
      return 1;
    }
    error('Runtime enrollment failed. Check arguments, private file permissions and a new output directory. Existing grants were not replaced.');
    return 1;
  }
}
