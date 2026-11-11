import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectPackageInventory, validatePackageMetadata, validatePackedPackage } from '../scripts/check-package.mjs';

const METADATA = {
  name: '@abot-ai/socket', version: '0.1.0', private: true, license: 'MIT',
  type: 'module', engines: { node: '>=24' }, bin: { 'abot-socket': 'bin/abot-socket.mjs' },
  scripts: { start: 'node bin/abot-socket.mjs start' },
  files: ['bin/abot-socket.mjs', 'src/main.mjs',
    'src/auth/*.mjs', 'src/cli/*.mjs', 'src/config/*.mjs', 'src/deployment/*.mjs',
    'src/notifications/*.mjs', 'src/pairing/*.mjs', 'src/protocol/*.mjs',
    'src/relay/*.mjs', 'src/review/*.mjs', 'src/setup/*.mjs', 'src/transport/*.mjs',
    'README.md', 'LICENSE', 'config.example.json',
    'docs/SELF-HOSTING.md', 'docs/PROTOCOL.md', 'docs/SECURITY.md',
    'docs/MIGRATION.md', 'docs/DEPLOYMENT.md', 'docs/INSTALLATION.md', 'docs/APP-REVIEW.md'],
};
const FILES = ['package.json', 'bin/abot-socket.mjs', 'src/main.mjs', 'src/auth/auth.mjs', 'README.md'];
const clone = (value) => structuredClone(value);

function packed(files = FILES) {
  return [{ name: METADATA.name, version: METADATA.version, files: files.map((path) => ({
    path, size: 20, mode: path === 'bin/abot-socket.mjs' ? 0o755 : 0o644,
  })) }];
}

test('package inspection accepts exactly the expected private scoped package inventory', () => {
  assert.deepEqual(validatePackedPackage(packed(), METADATA, FILES), {
    name: METADATA.name, version: METADATA.version, files: FILES.length, unpackedBytes: FILES.length * 20,
  });
});

test('secret, state, development, dependency and escaping paths cannot enter the package', () => {
  for (const path of ['.env', '.npmrc', 'private-config.json', 'runtime-connection.json',
    'review-access.txt', 'review-portal.json', 'state/auth.sqlite3', 'test/auth.test.mjs', 'scripts/check-package.mjs',
    'node_modules/ws/index.js', '../private.json', 'src/../secret.mjs', 'src/.hidden.mjs',
    'src/auth.mjs', 'src/unknown/module.mjs', 'src/auth/nested/module.mjs', 'src/auth/.hidden.mjs']) {
    assert.throws(() => validatePackedPackage(packed([...FILES, path]), METADATA, FILES), /Unexpected file/);
  }
});

test('a missing source module, duplicate or nonexecutable bin rejects the artifact', () => {
  assert.throws(() => validatePackedPackage(packed(FILES.filter((name) => name !== 'src/auth/auth.mjs')), METADATA, FILES), /missing required/);
  assert.throws(() => validatePackedPackage(packed([...FILES, FILES[0]]), METADATA, FILES), /Duplicate/);
  const artifact = packed();
  artifact[0].files.find((file) => file.path === 'bin/abot-socket.mjs').mode = 0o644;
  assert.throws(() => validatePackedPackage(artifact, METADATA, FILES), /not executable/);
});

test('unexpected identity, invalid file metadata and multiple pack results fail inspection', () => {
  const identity = packed(); identity[0].name = 'other-package';
  assert.throws(() => validatePackedPackage(identity, METADATA, FILES), /identity/);
  assert.throws(() => validatePackedPackage([...packed(), ...packed()], METADATA, FILES), /one npm/);
  for (const alteration of [{ size: -1 }, { size: '20' }, { mode: 0o4755 }]) {
    const artifact = packed(); Object.assign(artifact[0].files[0], alteration);
    assert.throws(() => validatePackedPackage(artifact, METADATA, FILES), /Invalid packed/);
  }
});

test('publication guards and explicit allowlist cannot be removed during preparation', () => {
  for (const alteration of [{ private: false }, { license: 'UNLICENSED' }, { files: ['.'] },
    { bin: { other: 'src/main.mjs' } }, { engines: { node: '>=18' } },
    { bundleDependencies: true }, { bundledDependencies: ['ws'] }]) {
    assert.throws(() => validatePackageMetadata({ ...METADATA, ...alteration }));
  }
});

test('automatic installation and packaging lifecycle scripts are rejected', () => {
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack',
    'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish']) {
    const metadata = clone(METADATA); metadata.scripts[name] = 'node unexpected.mjs';
    assert.throws(() => validatePackageMetadata(metadata), /lifecycle/);
  }
});

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'abot-package-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const pattern of METADATA.files.filter((name) => name.includes('*'))) {
    mkdirSync(join(root, dirname(pattern)), { recursive: true });
  }
  const paths = ['package.json', ...METADATA.files.filter((name) => !name.includes('*')), 'src/auth/auth.mjs'];
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'fixture');
  }
  return { root, paths };
}

test('source inventory expands all source modules and excludes unrelated local material', (t) => {
  const { root, paths } = sourceFixture(t);
  writeFileSync(join(root, '.env'), 'dummy-not-packed');
  writeFileSync(join(root, 'src', 'config.private.json'), 'dummy-not-packed');
  assert.deepEqual(collectPackageInventory(root, METADATA), paths.sort());
});

test('source symlinks and missing explicit documentation reject collection', (t) => {
  const { root } = sourceFixture(t);
  const module = join(root, 'src/auth/auth.mjs');
  rmSync(module); symlinkSync(join(root, 'README.md'), module);
  assert.throws(() => collectPackageInventory(root, METADATA), /symlinks/);
  rmSync(module); writeFileSync(module, 'fixture');
  rmSync(join(root, 'docs/INSTALLATION.md'));
  assert.throws(() => collectPackageInventory(root, METADATA));
});

test('domain directory symlinks reject collection before following their contents', (t) => {
  const { root } = sourceFixture(t);
  const domain = join(root, 'src/relay');
  rmSync(domain, { recursive: true });
  symlinkSync(join(root, 'src/auth'), domain);
  assert.throws(() => collectPackageInventory(root, METADATA), /symlinks/);
});
