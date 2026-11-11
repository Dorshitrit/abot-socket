import { constants, closeSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const DATABASE_NAME = 'auth.sqlite3';
const STATE_FILES = new Set([DATABASE_NAME, `${DATABASE_NAME}-journal`]);

function assertOwnedPrivateEntry(path, stat, mode, directory) {
  const correctType = directory ? stat.isDirectory() : stat.isFile();
  if (!correctType || stat.isSymbolicLink()) throw new Error(`Unsafe authentication state entry: ${basename(path)}`);
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
    throw new Error('Authentication state must belong to the current user');
  }
  if ((stat.mode & 0o7777) !== mode) throw new Error(`Authentication state requires mode ${mode.toString(8)}`);
  if (!directory && stat.nlink !== 1) throw new Error('Authentication state files cannot have multiple links');
}

function assertDirectoryAncestors(path) {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Authentication state path cannot contain symlinks');
  }
}

export function assertPrivateStateDirectory(stateDirectory) {
  assertDirectoryAncestors(stateDirectory);
  assertOwnedPrivateEntry(stateDirectory, lstatSync(stateDirectory), 0o700, true);
  for (const name of readdirSync(stateDirectory)) {
    if (!STATE_FILES.has(name)) throw new Error(`Unexpected authentication state entry: ${name}`);
    const path = join(stateDirectory, name);
    try {
      assertOwnedPrivateEntry(path, lstatSync(path), 0o600, false);
    } catch (error) {
      // Another connection can finish a DELETE-mode transaction during inspection.
      if (name.endsWith('-journal') && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

/** Create only the requested private directory and database, never repair existing paths. */
export function prepareAuthenticationDatabase(stateDirectory) {
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) {
    throw new TypeError('An absolute authentication stateDirectory is required');
  }
  if (stateDirectory !== resolve(stateDirectory)) throw new TypeError('Authentication stateDirectory must be canonical');
  assertDirectoryAncestors(dirname(stateDirectory));
  try { mkdirSync(stateDirectory, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  assertPrivateStateDirectory(stateDirectory);
  const path = join(stateDirectory, DATABASE_NAME);
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  assertPrivateStateDirectory(stateDirectory);
  return { path, stat: lstatSync(path) };
}

export function assertSameDatabaseFile(stateDirectory, prepared) {
  assertPrivateStateDirectory(stateDirectory);
  const stat = lstatSync(prepared.path);
  if (stat.dev !== prepared.stat.dev || stat.ino !== prepared.stat.ino) {
    throw new Error('Authentication database changed during opening');
  }
}
