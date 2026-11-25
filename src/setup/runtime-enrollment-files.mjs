import * as filesystem from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readPrivateConfiguration } from '../config/config.mjs';

function assertEnrollmentOwner(path, io, directory = false) {
  const stat = io.lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe enrollment path');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Enrollment requires the configuration owner');
  if (directory && (stat.mode & 0o022)) throw new Error('Configuration directory must not be writable by others');
  if (!directory && ((stat.mode & 0o077) || stat.nlink !== 1)) throw new Error('Configuration must be private and singly linked');
  return stat;
}

function syncDirectory(directory, io) {
  const descriptor = io.openSync(directory, io.constants.O_RDONLY);
  try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
}

function writeNewPrivateFile(path, content, io, created) {
  const descriptor = io.openSync(path, 'wx', 0o600);
  created();
  try { io.writeFileSync(descriptor, content); io.fsyncSync(descriptor); }
  finally { io.closeSync(descriptor); }
}

/** Prepare the private handoff first; the final atomic rename adds only its grant. */
export function writeRuntimeEnrollment({ configPath, directory, prepare }, io = filesystem) {
  const parent = dirname(configPath);
  assertEnrollmentOwner(parent, io, true);
  const originalStat = assertEnrollmentOwner(configPath, io);
  const lockPath = `${configPath}.add-runtime.lock`;
  const lock = io.openSync(lockPath, 'wx', 0o600);
  const connectionPath = join(directory, 'runtime-connection.json');
  const temporary = join(parent, `.add-runtime-${randomUUID()}.tmp`);
  let madeDirectory = false, madeConnection = false, madeTemporary = false, committed = false;
  try {
    const source = readPrivateConfiguration(configPath);
    const originalBytes = io.readFileSync(configPath);
    if (originalBytes.length > 32_768 || JSON.stringify(JSON.parse(originalBytes)) !== JSON.stringify(source)) {
      throw new Error('Configuration changed during enrollment');
    }
    const bundle = prepare(source);
    const encoded = `${JSON.stringify(bundle.config, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > 32_768) throw new Error('Configuration limit exceeded');
    // Exclusive directory and files: existing paths, including symlinks, are never reused.
    io.mkdirSync(directory, { mode: 0o700 });
    madeDirectory = true;
    writeNewPrivateFile(connectionPath, `${JSON.stringify(bundle.runtimeConnection, null, 2)}\n`, io, () => { madeConnection = true; });
    syncDirectory(directory, io);
    syncDirectory(dirname(directory), io);
    writeNewPrivateFile(temporary, encoded, io, () => { madeTemporary = true; });
    io.chmodSync(temporary, originalStat.mode & 0o777);
    const currentStat = assertEnrollmentOwner(configPath, io);
    if (currentStat.dev !== originalStat.dev || currentStat.ino !== originalStat.ino ||
        !io.readFileSync(configPath).equals(originalBytes)) throw new Error('Configuration changed during enrollment');
    io.renameSync(temporary, configPath);
    committed = true;
    madeTemporary = false;
    syncDirectory(parent, io);
    return { directory, configPath, runtimeConnectionPath: connectionPath, runtimeId: bundle.runtimeConnection.runtimeId };
  } catch (failure) {
    if (committed) throw Object.assign(new Error('Enrollment committed; verify durability before restart'), { code: 'enrollment_committed_unconfirmed' });
    const failures = [failure];
    for (const [created, path] of [[madeTemporary, temporary], [madeConnection, connectionPath]]) {
      if (!created) continue;
      try { io.unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') failures.push(error); }
    }
    if (madeDirectory) {
      try { io.rmdirSync(directory); } catch (error) { failures.push(error); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Enrollment cleanup incomplete');
    throw failure;
  } finally {
    try {
      try { io.closeSync(lock); } finally { io.unlinkSync(lockPath); }
    } catch (failure) {
      if (committed) throw Object.assign(new Error('Enrollment committed; inspect the remaining lock'), { code: 'enrollment_committed_unconfirmed' });
      throw failure;
    }
  }
}
