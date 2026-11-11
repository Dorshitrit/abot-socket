const OPTION_NAMES = new Map([
  ['--output', 'output'], ['--origin', 'origin'],
  ['--runtime-id', 'runtimeId'], ['--port', 'port'],
]);

export function parseSetupArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = OPTION_NAMES.get(args[index]);
    if (!name || Object.hasOwn(options, name)) throw new Error('Unknown or duplicate setup option');
    const value = args[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error('Every setup option needs a value');
    }
    if (name !== 'port') { options[name] = value; continue; }
    if (!/^\d{1,5}$/.test(value)) throw new Error('Invalid port');
    options.port = Number(value);
  }
  for (const name of ['output', 'origin', 'runtimeId']) {
    if (!options[name]) throw new Error('Missing required setup option');
  }
  return options;
}
