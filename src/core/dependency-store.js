import path from 'node:path';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink } from 'node:fs/promises';

const isWindows = process.platform === 'win32';

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function lockfileHash(cwd) {
  const bytes = await readFile(path.join(cwd, 'package-lock.json'));
  return createHash('sha256').update(bytes).digest('hex');
}

export class DependencyStore {
  constructor({ cwd, data = path.join(cwd, 'data'), run }) {
    this.cwd = cwd;
    this.data = data;
    this.run = run;
    this.root = path.join(cwd, 'node_modules');
    this.deps = path.join(data, 'deps');
  }

  async prepare() {
    const hash = await lockfileHash(this.cwd);
    const target = path.join(this.deps, hash, 'node_modules');
    await mkdir(path.dirname(target), { recursive: true });
    if (!(await exists(target))) {
      const staging = path.join(this.deps, `.${hash}-${process.pid}-${Date.now()}`);
      await mkdir(staging, { recursive: true });
      try {
        await cp(path.join(this.cwd, 'package.json'), path.join(staging, 'package.json'));
        await cp(path.join(this.cwd, 'package-lock.json'), path.join(staging, 'package-lock.json'));
        await this.run(isWindows ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], { cwd: staging });
        await rename(path.join(staging, 'node_modules'), target);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const stat = await lstat(this.root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    return { hash, target, rootKind: stat?.isSymbolicLink() ? 'link' : stat ? 'directory' : 'missing', previous: stat };
  }

  async migrateExisting() {
    const hash = await lockfileHash(this.cwd);
    const target = path.join(this.deps, hash, 'node_modules');
    const stat = await lstat(this.root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat || stat.isSymbolicLink()) return { migrated: false, hash, target, rootKind: stat?.isSymbolicLink() ? 'link' : 'missing' };
    await mkdir(path.dirname(target), { recursive: true });
    if (await exists(target)) throw new Error(`依赖目录已存在但根目录仍是真实目录：${hash}`);
    await rename(this.root, target);
    try { await symlink(target, this.root, isWindows ? 'junction' : 'dir'); }
    catch (error) {
      if (!(await exists(this.root)) && await exists(target)) await rename(target, this.root);
      throw error;
    }
    return { migrated: true, hash, target, rootKind: 'link' };
  }

  async activate(plan) {
    const old = this.root;
    const oldBackup = path.join(this.deps, `previous-${Date.now()}-${process.pid}`);
    const stat = await lstat(old).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const previousTarget = stat?.isSymbolicLink() ? await readlinkSafe(old) : null;
    if (stat && !stat.isSymbolicLink()) {
      // The service must be stopped before this rename on Windows when native DLLs are loaded.
      await rename(old, oldBackup);
    } else if (stat) await unlink(old);
    try {
      await symlink(plan.target, old, isWindows ? 'junction' : 'dir');
    } catch (error) {
      if (stat && !await exists(old) && await exists(oldBackup)) await rename(oldBackup, old);
      else if (previousTarget && !await exists(old)) await symlink(previousTarget, old, isWindows ? 'junction' : 'dir');
      throw error;
    }
    return { oldBackup, previousTarget, hadRoot: Boolean(stat) };
  }

  async restore(state) {
    const hasBackup = Boolean(state?.oldBackup && await exists(state.oldBackup));
    if (!hasBackup && !state?.previousTarget) return;
    await rm(this.root, { recursive: true, force: true });
    if (state?.oldBackup && await exists(state.oldBackup)) await rename(state.oldBackup, this.root);
    else if (state?.previousTarget) await symlink(state.previousTarget, this.root, isWindows ? 'junction' : 'dir');
  }

  async prune(keep = 2, protect = []) {
    const entries = await readdir(this.deps, { withFileTypes: true });
    const active = await readlinkSafe(this.root);
    const protectedDirs = new Set([active, ...protect].filter(Boolean)
      .map(target => path.resolve(path.dirname(target.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')))));
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const full = path.resolve(this.deps, entry.name);
      dirs.push({ full, mtime: (await lstat(full)).mtimeMs });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    let kept = dirs.filter(dir => protectedDirs.has(dir.full)).length;
    for (const dir of dirs) {
      if (protectedDirs.has(dir.full)) continue;
      if (kept < keep) { kept += 1; continue; }
      await rm(dir.full, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function readlinkSafe(file) {
  try { return await readlink(file); } catch { return null; }
}
