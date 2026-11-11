import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@abot-ai/socket';
const BIN_PATH = 'bin/abot-socket.mjs';
const SOURCE_DOMAINS = Object.freeze([
  'auth', 'cli', 'config', 'deployment', 'notifications', 'pairing',
  'protocol', 'relay', 'review', 'setup', 'transport',
]);
const SOURCE_PATTERN = /^src\/([a-z]+)\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/;
const DISTRIBUTION_FILES = Object.freeze([
  BIN_PATH, 'src/main.mjs', ...SOURCE_DOMAINS.map((domain) => `src/${domain}/*.mjs`),
  'README.md', 'LICENSE', 'config.example.json',
  'docs/SELF-HOSTING.md', 'docs/PROTOCOL.md', 'docs/SECURITY.md',
  'docs/MIGRATION.md', 'docs/DEPLOYMENT.md', 'docs/INSTALLATION.md', 'docs/APP-REVIEW.md',
]);
const STATIC_FILES = new Set(['package.json', ...DISTRIBUTION_FILES.filter((name) => !name.includes('*'))]);
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack',
  'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish'];

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExactFileAllowlist(files) {
  if (!Array.isArray(files) || files.length !== DISTRIBUTION_FILES.length) return false;
  return [...files].sort().every((name, index) => name === [...DISTRIBUTION_FILES].sort()[index]);
}

function hasNoBundledDependencies(metadata) {
  return ['bundleDependencies', 'bundledDependencies'].every((name) => {
    const value = metadata[name];
    return value === undefined || value === false || (Array.isArray(value) && value.length === 0);
  });
}

export function validatePackageMetadata(metadata) {
  requireContract(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid package metadata');
  requireContract(metadata.name === PACKAGE_NAME, 'Unexpected package name');
  requireContract(!Object.hasOwn(metadata, 'private'), 'Release metadata must not contain a private flag');
  requireContract(metadata.publishConfig?.registry === 'https://registry.npmjs.org/', 'Publication must target the official npm registry');
  requireContract(metadata.publishConfig?.access === 'public', 'The scoped release must have public access');
  requireContract(metadata.license === 'MIT', 'The approved MIT license is required');
  requireContract(typeof metadata.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version), 'Invalid package version');
  requireContract(metadata.type === 'module' && metadata.engines?.node === '>=24', 'Unexpected runtime requirements');
  requireContract(metadata.bin?.['abot-socket'] === BIN_PATH && Object.keys(metadata.bin).length === 1, 'Unexpected executable contract');
  requireContract(hasExactFileAllowlist(metadata.files), 'Distribution file allowlist changed');
  requireContract(hasNoBundledDependencies(metadata), 'Bundled dependencies are not part of this package');
  requireContract(!LIFECYCLE_HOOKS.some((name) => Object.hasOwn(metadata.scripts ?? {}, name)), 'Automatic lifecycle hooks are not permitted');
}

function isAllowedPackagePath(path) {
  if (typeof path !== 'string') return false;
  if (STATIC_FILES.has(path)) return true;
  const match = SOURCE_PATTERN.exec(path);
  return Boolean(match && SOURCE_DOMAINS.includes(match[1]));
}

function assertRegularSourceFile(directory, relativePath) {
  const parts = relativePath.split('/');
  let current = directory;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stat = lstatSync(current);
    requireContract(!stat.isSymbolicLink(), 'Distribution sources cannot be symlinks');
    const expectedType = index === parts.length - 1 ? stat.isFile() : stat.isDirectory();
    requireContract(expectedType, 'Distribution source has an unexpected file type');
  }
}

/** Inventory only. Running the installed tarball remains a separate consumer check. */
export function collectPackageInventory(directory, metadata) {
  validatePackageMetadata(metadata);
  const srcDirectory = lstatSync(join(directory, 'src'));
  requireContract(srcDirectory.isDirectory() && !srcDirectory.isSymbolicLink(), 'Source directory cannot be a symlink');
  const sourceFiles = SOURCE_DOMAINS.flatMap((domain) => {
    const path = join(directory, 'src', domain);
    const stat = lstatSync(path);
    requireContract(!stat.isSymbolicLink(), 'Source domain directories cannot be symlinks');
    requireContract(stat.isDirectory(), 'Source domain must be a directory');
    return readdirSync(path).filter((name) => name.endsWith('.mjs'))
      .map((name) => `src/${domain}/${name}`);
  });
  requireContract(sourceFiles.length > 0, 'Package source inventory is empty');
  const expected = [...STATIC_FILES, ...sourceFiles].sort();
  for (const path of expected) {
    requireContract(isAllowedPackagePath(path), 'Unexpected source filename');
    assertRegularSourceFile(directory, path);
  }
  return expected;
}

export function validatePackedPackage(packJson, metadata, expectedFiles) {
  validatePackageMetadata(metadata);
  requireContract(Array.isArray(packJson) && packJson.length === 1, 'Expected one npm pack result');
  const artifact = packJson[0];
  requireContract(artifact?.name === metadata.name && artifact.version === metadata.version, 'Packed package identity differs from source');
  requireContract(Array.isArray(artifact.files), 'Missing npm pack file inventory');
  requireContract(Array.isArray(expectedFiles) && expectedFiles.every(isAllowedPackagePath), 'Invalid expected file inventory');
  const expected = new Set(expectedFiles);
  requireContract(expected.has(BIN_PATH) && expected.has('package.json'), 'Expected inventory must contain the executable and metadata');
  const seen = new Set();
  let unpackedBytes = 0;
  for (const file of artifact.files) {
    requireContract(isAllowedPackagePath(file.path) && expected.has(file.path), 'Unexpected file in npm package');
    requireContract(!seen.has(file.path), 'Duplicate file in npm package');
    requireContract(Number.isSafeInteger(file.size) && file.size >= 0, 'Invalid packed file size');
    requireContract(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, 'Invalid packed file mode');
    if (file.path === BIN_PATH) requireContract((file.mode & 0o111) !== 0, 'The npm executable is not executable');
    seen.add(file.path);
    unpackedBytes += file.size;
  }
  requireContract(seen.size === expected.size, 'The npm package is missing required source files');
  return { name: metadata.name, version: metadata.version, files: seen.size, unpackedBytes };
}

export function checkPackageFile(packFile, directory = fileURLToPath(new URL('../', import.meta.url))) {
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const inventory = collectPackageInventory(directory, metadata);
  const packed = JSON.parse(readFileSync(packFile, 'utf8'));
  return validatePackedPackage(packed, metadata, inventory);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/check-package.mjs <npm-pack-json-file>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(checkPackageFile(process.argv[2]))); }
    catch {
      console.error('Package inspection failed. Check the explicit file inventory, executable mode and publication guard.');
      process.exitCode = 1;
    }
  }
}
