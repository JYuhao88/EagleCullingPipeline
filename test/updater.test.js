import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Updater, officialOrigin, UPDATE_INTERVAL } from '../src/core/updater.js';
import { lowPriority } from '../src/core/update-process.js';
import { checkUpdateVersion } from '../scripts/check-update-version.mjs';
import { shouldAutoUpdate } from '../src/plugin/update-banner.js';

function command(cwd, command, args) {
  return new Promise((resolve, reject) => {
    const child = lowPriority(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(error || `exit ${code}`)) : resolve(output.trim()));
  });
}
async function fixture(t, { offMaster = false, lockChange = false, mismatch = false, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'culling-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = path.join(root, 'origin.git'), source = path.join(root, 'source'), cwd = path.join(root, 'clone');
  await mkdir(source);
  const git = (...args) => command(source, 'git', args);
  await command(root, 'git', ['init', '--bare', bare]);
  await git('init', '-b', 'master');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await mkdir(path.join(source, 'docs'));
  await mkdir(path.join(source, 'src/plugin'), { recursive: true });
  await writeFile(path.join(source, '.gitignore'), 'data/\nnode_modules/\n');
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    if (version === '1.2.0' && offMaster) await git('checkout', '-b', 'side');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version, type: 'module' }));
    await writeFile(path.join(source, 'src/plugin/manifest.json'), JSON.stringify({
      version: mismatch && version === '1.2.0' ? '1.1.0' : version,
    }));
    await writeFile(path.join(source, `docs/release-notes-v${version}.md`), `Release ${version}`);
    if (lockChange) await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ version }));
    await git('add', '.');
    await git('commit', '-m', `release ${version}`);
    if (version === '1.2.0') await git('tag', '-a', `v${version}`, '-m', 'annotated release');
    else await git('tag', `v${version}`);
  }
  if (offMaster) await git('checkout', 'master');
  await git('tag', 'v9.0.0-beta.1');
  await git('remote', 'add', 'origin', bare);
  await git('push', 'origin', 'master', '--tags');
  await command(root, 'git', ['clone', bare, cwd]);
  await command(cwd, 'git', ['checkout', '--detach', 'v1.0.0']);
  const updater = new Updater({ cwd, acceptOrigin: value => value === bare, restart: async () => {}, ...options });
  return { updater, cwd, root, git: (...args) => command(cwd, 'git', args) };
}

test('checks tags and notes without REST even when API would return 403; caches for six hours', async t => {
  let clock = Date.now();
  const { updater } = await fixture(t, { now: () => clock });
  let calls = 0;
  const run = updater.run;
  updater.run = (cmd, args) => { if (args[0] === 'ls-remote') calls++; return run(cmd, args); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('403 API rate limit'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const status = await updater.status();
  assert.equal(status.currentVersion, 'v1.0.0');
  assert.equal(status.latestVersion, 'v1.2.0');
  assert.equal(status.hasUpdate, true);
  assert.match(status.releaseNotes, /Release 1.2.0/);
  await updater.status(); assert.equal(calls, 1);
  clock += UPDATE_INTERVAL; await updater.status(); assert.equal(calls, 2);
});

test('dirty clone is refused without changing user edits', async t => {
  const { updater, cwd, git } = await fixture(t);
  const head = await git('rev-parse', 'HEAD');
  await writeFile(path.join(cwd, 'user.txt'), 'keep');
  await assert.rejects(updater.apply(), /未提交改动/);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(cwd, 'user.txt'), 'utf8'), 'keep');
});

test('active analysis is refused', async t => {
  const { updater } = await fixture(t, { isBusy: () => true });
  await assert.rejects(updater.apply(), /正在分析/);
});

test('tag outside master is refused', async t => {
  const { updater, git } = await fixture(t, { offMaster: true });
  const head = await git('rev-parse', 'HEAD');
  await assert.rejects(updater.apply());
  assert.equal(await git('rev-parse', 'HEAD'), head);
});

test('npm ci failure restores original commit and dependencies', async t => {
  const { updater, git } = await fixture(t, { lockChange: true });
  const head = await git('rev-parse', 'HEAD');
  const run = updater.run; let installs = 0;
  updater.run = (cmd, args) => {
    if (cmd.startsWith('npm')) {
      assert.deepEqual(args, ['ci', '--ignore-scripts']);
      if (++installs === 1) throw new Error('npm ci failed');
      return '';
    }
    return run(cmd, args);
  };
  await assert.rejects(updater.apply(), /已恢复原版本/);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.equal(installs, 2);
});

test('restart failure restores original commit and retains user data', async t => {
  const { updater, cwd, git } = await fixture(t, { restart: async () => { throw new Error('restart failed'); } });
  const head = await git('rev-parse', 'HEAD');
  await mkdir(path.join(cwd, 'data/runs'), { recursive: true });
  await writeFile(path.join(cwd, 'data/runs/decision.json'), 'keep');
  await assert.rejects(updater.apply(), /已恢复原版本/);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(cwd, 'data/runs/decision.json'), 'utf8'), 'keep');
});

test('apply uses detached release and rollback returns previous version', async t => {
  const { updater, git } = await fixture(t);
  const old = await git('rev-parse', 'HEAD');
  await updater.apply();
  assert.equal(await git('describe', '--tags', '--exact-match'), 'v1.2.0');
  assert.equal(await git('branch', '--show-current'), '');
  assert.equal((await updater.status()).canRollback, true);
  await updater.apply({ rollback: true });
  assert.equal(await git('rev-parse', 'HEAD'), old);
});

test('unknown origins are rejected', async t => {
  for (const value of ['https://github.com/other/project', 'file:///tmp/repo', 'https://github.com.evil.invalid/x']) {
    assert.equal(officialOrigin(value), false);
  }
  for (const value of ['https://github.com/JYuhao88/EagleCullingPipeline.git', 'git@github.com:JYuhao88/EagleCullingPipeline.git',
    'ssh://git@github.com/JYuhao88/EagleCullingPipeline.git']) assert.equal(officialOrigin(value), true);
  const { updater } = await fixture(t);
  updater.acceptOrigin = officialOrigin;
  await assert.rejects(updater.apply(), /origin/);
});

test('mismatched package and plugin release versions are refused before checkout', async t => {
  const { updater, git } = await fixture(t, { mismatch: true });
  const old = await git('rev-parse', 'HEAD');
  await assert.rejects(updater.apply(), /版本号与 tag 不一致/);
  assert.equal(await git('rev-parse', 'HEAD'), old);
});

test('version check and automatic update safety policy', async t => {
  const { cwd } = await fixture(t);
  assert.equal(await checkUpdateVersion('v1.0.0', cwd), '1.0.0');
  await assert.rejects(checkUpdateVersion('v1.1.0', cwd), /tag/);
  const options = { status: { hasUpdate: true, canUpdate: true }, enabled: true, reviewing: false, postponed: false };
  assert.equal(shouldAutoUpdate(options), true);
  for (const override of [{ reviewing: true }, { enabled: false }, { postponed: true }, { status: { hasUpdate: true } }]) {
    assert.equal(shouldAutoUpdate({ ...options, ...override }), false);
  }
});
