import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateInstallation } from '../src/setup/setup-files.mjs';

const BUNDLE = { config: { fixture: true }, runtimeConnection: { fixtureToken: 'dummy-only' } };

test('partial write failure cleans only newly owned files and permits a fresh setup retry', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'abot-setup-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unrelated = join(root, 'keep.txt');
  fs.writeFileSync(unrelated, 'existing');
  for (const failAt of [1, 2]) {
    const directory = join(root, `installation-${failAt}`);
    let writes = 0;
    const failure = new Error('simulated partial write');
    const io = { ...fs, writeFileSync(fd, content) {
      writes += 1;
      if (writes !== failAt) return fs.writeFileSync(fd, content);
      fs.writeFileSync(fd, content.slice(0, 5));
      throw failure;
    } };
    assert.throws(() => writePrivateInstallation(directory, BUNDLE, io), (error) => error === failure);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'existing');
    writePrivateInstallation(directory, BUNDLE);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(directory, 'config.json'), 'utf8')), BUNDLE.config);
  }
});

test('cleanup failure retains the original cause and an existing directory is untouched', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'abot-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'installation');
  const failure = new Error('write failure');
  const io = { ...fs, writeFileSync() { throw failure; }, unlinkSync() { throw new Error('cleanup failure'); } };
  assert.throws(() => writePrivateInstallation(directory, BUNDLE, io),
    (error) => error instanceof AggregateError && error.errors[0] === failure);
  assert.throws(() => writePrivateInstallation(directory, BUNDLE));
  assert.equal(fs.existsSync(join(directory, 'runtime-connection.json')), false);
});
