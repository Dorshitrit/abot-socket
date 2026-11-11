import * as filesystem from 'node:fs';
import { join } from 'node:path';

function removeFailedInstallation(directory, created, io) {
  const failures = [];
  for (const path of created.reverse()) {
    try { io.unlinkSync(path); } catch (error) { failures.push(error); }
  }
  try { io.rmdirSync(directory); } catch (error) { failures.push(error); }
  return failures;
}

export function writePrivateInstallation(directory, bundle, io = filesystem) {
  // Serialize before creating anything. Names are fixed, never caller-supplied paths.
  const files = [
    ['config.json', JSON.stringify(bundle.config, null, 2)],
    ['runtime-connection.json', JSON.stringify(bundle.runtimeConnection, null, 2)],
  ];
  // Exclusive/non-recursive: existing directories and symlinks are not reused.
  io.mkdirSync(directory, { mode: 0o700 });
  const created = [];
  try {
    for (const [name, content] of files) {
      const path = join(directory, name);
      const descriptor = io.openSync(path, 'wx', 0o600);
      created.push(path); // Own the file even if a later write fails partially.
      try { io.writeFileSync(descriptor, `${content}\n`); }
      finally { io.closeSync(descriptor); }
    }
  } catch (error) {
    const failures = removeFailedInstallation(directory, created, io);
    if (failures.length) {
      throw new AggregateError([error, ...failures], 'Setup write failed and cleanup was incomplete');
    }
    throw error;
  }
}
