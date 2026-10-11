import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DependencyStore } from '../src/core/dependency-store.js';

async function fixture(t, linked = true) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'depswap-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const old = path.join(cwd, 'data/deps/old/node_modules');
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'marker'), 'old');
  if (linked) await (await import('node:fs/promises')).symlink(old, path.join(cwd, 'node_modules'), 'dir');
  else await mkdir(path.join(cwd, 'node_modules'), { recursive: true });
  const run = async (_command, args, options) => {
    const prefix = options.cwd;
    await mkdir(path.join(prefix, 'node_modules'), { recursive: true });
    await writeFile(path.join(prefix, 'node_modules', 'marker'), 'new');
  };
  return { cwd, store: new DependencyStore({ cwd, run }) };
}

test('switches a junction/symlink atomically and restores the old target', async t => {
  const { cwd, store } = await fixture(t);
  const plan = await store.prepare();
  const state = await store.activate(plan);
  assert.equal((await readlink(path.join(cwd, 'node_modules'))), plan.target);
  await store.restore(state);
  const restored = path.normalize(await readlink(path.join(cwd, 'node_modules')));
  assert.equal(restored, path.normalize(path.join(cwd, 'data/deps/old/node_modules')));
});

test('migrates a real node_modules directory without deleting it before activation', async t => {
  const { cwd, store } = await fixture(t, false);
  await writeFile(path.join(cwd, 'node_modules', 'marker'), 'old');
  const plan = await store.prepare();
  assert.equal(plan.rootKind, 'directory');
  const state = await store.activate(plan);
  assert.equal((await lstat(path.join(cwd, 'node_modules'))).isSymbolicLink(), true);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(state.oldBackup, 'marker'), 'utf8'), 'old');
  await store.restore(state);
  assert.equal((await lstat(path.join(cwd, 'node_modules'))).isDirectory(), true);
});

test('migrates an existing directory during candidate bootstrap', async t => {
  const { cwd, store } = await fixture(t, false);
  const result = await store.migrateExisting();
  assert.equal(result.migrated, true);
  assert.equal((await lstat(path.join(cwd, 'node_modules'))).isSymbolicLink(), true);
  assert.equal((await lstat(result.target)).isDirectory(), true);
});

test('failed activation leaves the current link untouched', async t => {
  const { cwd, store } = await fixture(t);
  const plan = await store.prepare();
  const original = await readlink(path.join(cwd, 'node_modules'));
  const bad = { ...plan, target: `${cwd}\0` };
  await assert.rejects(store.activate(bad));
  assert.equal(await readlink(path.join(cwd, 'node_modules')), original);
});

test('restore without a switch state never deletes the current node_modules', async t => {
  const { cwd, store } = await fixture(t, false);
  await writeFile(path.join(cwd, 'node_modules', 'keep'), 'x');
  await store.restore(null);
  await store.restore({ oldBackup: path.join(cwd, 'data/deps/missing') });
  assert.ok((await lstat(path.join(cwd, 'node_modules', 'keep'))).isFile());
});

test('prune keeps the active and protected dependency dirs regardless of hash order', async t => {
  const { cwd, store } = await fixture(t);
  const { symlink, unlink, utimes } = await import('node:fs/promises');
  const hashes = ['0', 'f', '8', '4'].map(c => c.repeat(64));
  for (const [i, hash] of hashes.entries()) {
    const dir = path.join(cwd, 'data/deps', hash, 'node_modules');
    await mkdir(dir, { recursive: true });
    const time = new Date(Date.now() - (10 - i) * 60000);
    await utimes(path.dirname(dir), time, time);
  }
  await unlink(path.join(cwd, 'node_modules'));
  await symlink(path.join(cwd, 'data/deps', hashes[0], 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
  await store.prune(2, [path.join(cwd, 'data/deps', hashes[1], 'node_modules')]);
  const exists = async hash => lstat(path.join(cwd, 'data/deps', hash)).then(() => true, () => false);
  assert.deepEqual(await Promise.all(hashes.map(exists)), [true, true, false, false]);
});
