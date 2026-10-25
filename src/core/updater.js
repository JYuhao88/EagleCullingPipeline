import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, open, unlink, realpath } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lowPriority } from './update-process.js';
import { DependencyStore } from './dependency-store.js';

export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
export const MANUAL_CHECK_INTERVAL = 60 * 1000;
export const REPOSITORY = 'https://github.com/JYuhao88/EagleCullingPipeline';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function officialOrigin(value) {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)JYuhao88\/EagleCullingPipeline(?:\.git)?\/?$/i
    .test(value);
}
export function compareTags(a, b) {
  const left = a.slice(1).split('.').map(Number), right = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
// Git refuses a clone owned by another account, e.g. one cloned from an administrator terminal.
export function ownershipMessage(cwd) {
  const dir = path.resolve(cwd).replaceAll('\\', '/');
  return `git 拒绝读取这个克隆：目录所有者不是当前用户（常见于在管理员终端里克隆）。`
    + `请运行 git config --global --add safe.directory ${dir}，或把目录所有者改为当前用户`;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}

export class Updater {
  constructor({ cwd = root, isBusy = () => false, restart = null, run, acceptOrigin = officialOrigin, now = Date.now } = {}) {
    Object.assign(this, { cwd, isBusy, restart, acceptOrigin, now });
    this.data = path.join(cwd, 'data');
    this.phase = 'idle';
    this.error = null;
    this.run = run || ((command, args, options) => this.command(command, args, options));
  }
  async command(command, args, { cwd = this.cwd } = {}) {
    await mkdir(path.join(this.data, 'logs'), { recursive: true });
    this.logFile ||= path.join(this.data, 'logs', `update-${this.now()}-${randomUUID()}.log`);
    const log = createWriteStream(this.logFile, { flags: 'a' });
    log.write(`${command} ${args.join(' ')}\n`);
    return new Promise((resolve, reject) => {
      const child = lowPriority(command, args, { cwd, detached: process.platform !== 'win32',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      let output = '', errors = '', timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') {
          lowPriority('taskkill.exe', ['/pid', String(child.pid), '/T', '/F']).on('error', () => child.kill());
        }
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, command.startsWith('npm') ? 600000 : 120000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
        log.write(data);
        if (stream === child.stdout) output = (output + data.toString()).slice(-1024 * 1024);
        else errors = (errors + data.toString()).slice(-4096);
      });
      child.on('error', error => { clearTimeout(timer); log.end(); reject(error); });
      child.on('close', code => {
        clearTimeout(timer); log.end();
        if (code === 0 && !timedOut) resolve(output.trim());
        else reject(new Error(timedOut ? '操作超时，请检查网络后重试'
          : command === 'git' && /dubious ownership/i.test(errors) ? ownershipMessage(cwd)
            : `${command} 失败（${code}），请查看更新日志`));
      });
    });
  }
  isUpdating() { return Boolean(this.updating || existsSync(path.join(this.data, 'update.lock'))); }
  git(...args) { return this.run('git', args); }
  async preflight() {
    if (this.isBusy()) throw new Error('正在分析照片，请等分析完成后更新');
    if (!this.restart) throw new Error('当前服务不支持自动重启，请用 CLI 启动服务');
    let top;
    try { top = await this.git('rev-parse', '--show-toplevel'); }
    catch (error) {
      if (error.message.startsWith('git 拒绝读取')) throw error;
      throw new Error('当前目录不是可读取的 git 克隆，请使用 git clone 安装');
    }
    if (await realpath(top) !== await realpath(this.cwd)) throw new Error('请从 git 克隆根目录启动');
    if (!this.acceptOrigin(await this.git('remote', 'get-url', 'origin'))) throw new Error('origin 不是指定的公开仓库');
    if (await this.git('status', '--porcelain', '--untracked-files=all')) throw new Error('工作区有未提交改动，请先保存或提交');
    return this.git('rev-parse', 'HEAD');
  }
  async status({ refresh = false } = {}) {
    await mkdir(this.data, { recursive: true });
    let reason = null, currentVersion = null;
    try { await this.preflight(); } catch (error) { reason = error.message; }
    try {
      const tags = (await this.git('tag', '--points-at', 'HEAD')).split('\n').filter(tag => tagPattern.test(tag));
      currentVersion = tags.sort(compareTags).at(-1) || null;
    } catch { /* Not a clone. */ }
    const packageVersion = (await readJson(path.join(this.cwd, 'package.json'), {})).version || null;
    let cache = await readJson(path.join(this.data, 'update-status.json'), {});
    const interval = refresh ? MANUAL_CHECK_INTERVAL : UPDATE_INTERVAL;
    if (!cache.checkedAt || this.now() - Date.parse(cache.checkedAt) >= interval) {
      cache = { ...cache, checkedAt: new Date(this.now()).toISOString(), checkError: null };
      try {
        if (!this.acceptOrigin(await this.git('remote', 'get-url', 'origin'))) throw new Error('origin 不是指定的公开仓库');
        const refs = await this.git('ls-remote', '--tags', 'origin');
        const tags = refs.split('\n').map(line => line.split('refs/tags/')[1]).filter(tag => tag && tagPattern.test(tag));
        cache.latestVersion = [...new Set(tags)].sort(compareTags).at(-1) || null;
        cache.releaseNotes = '';
        if (cache.latestVersion) {
          await this.git('fetch', '--no-tags', 'origin', `refs/tags/${cache.latestVersion}`);
          try { cache.releaseNotes = (await this.git('show', `FETCH_HEAD:docs/release-notes-${cache.latestVersion}.md`)).slice(0, 4000); }
          catch { cache.releaseNotes = '此版本未附更新说明。'; }
        }
      } catch (error) { cache.checkError = error.message; }
      await atomic(path.join(this.data, 'update-status.json'), cache);
    }
    const reference = currentVersion || `v${packageVersion}`;
    const hasUpdate = Boolean(cache.latestVersion && tagPattern.test(reference) && compareTags(cache.latestVersion, reference) > 0);
    const history = await readJson(path.join(this.data, 'update-history.json'), {});
    return { ...cache, currentVersion, packageVersion, root: path.resolve(this.cwd), hasUpdate,
      canUpdate: !reason && !this.isUpdating(),
      reason: reason || (this.isUpdating() ? '正在更新' : null), canRollback: Boolean(history.previous),
      phase: this.phase === 'idle' ? history.phase || 'idle' : this.phase,
      error: this.error || history.error || null, pythonChanged: this.pythonChanged || history.pythonChanged || false };
  }
  async install() {
    const store = new DependencyStore({ cwd: this.cwd, data: this.data, run: this.run });
    return store.prepare();
  }
  async apply({ rollback = false } = {}) {
    if (this.updating) throw new Error('正在更新，请稍候');
    this.updating = true;
    this.error = null;
    this.phase = 'preparing';
    this.logFile = null;
    let original, switched = false, dependencyChanged = false, lock, handoff, needsDependencyRepair = false;
    let dependencyStore = null, dependencyPlan = null, dependencyState = null;
    const historyFile = path.join(this.data, 'update-history.json');
    try {
      await mkdir(this.data, { recursive: true });
      lock = await open(path.join(this.data, 'update.lock'), 'wx');
      original = await this.preflight();
      const history = await readJson(historyFile, {});
      let target;
      if (rollback) {
        if (!/^[a-f0-9]{40}$/.test(history.previous || '')) throw new Error('没有可回退的版本');
        target = history.previous;
      } else {
        const status = await this.status();
        if (status.checkError) throw new Error(status.checkError);
        if (!status.hasUpdate) throw new Error('当前已经是最新正式版');
        target = status.latestVersion;
      }
      this.phase = 'download';
      await this.git('fetch', '--tags', 'origin', '+refs/heads/master:refs/remotes/origin/master');
      const commit = await this.git('rev-parse', '--verify', `${target}^{commit}`);
      try { await this.git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/master'); }
      catch { throw new Error('目标版本不属于 master 的发布历史，拒绝更新'); }
      if (await this.git('ls-tree', '-r', '--name-only', commit, '--', 'data')) {
        throw new Error('发布包含用户数据目录，拒绝更新');
      }
      if (!rollback) {
        const packageJson = JSON.parse(await this.git('show', `${commit}:package.json`));
        const manifest = JSON.parse(await this.git('show', `${commit}:src/plugin/manifest.json`));
        if (`v${packageJson.version}` !== target || manifest.version !== packageJson.version) {
          throw new Error('发布版本号与 tag 不一致，拒绝更新');
        }
      }
      // Check again after network I/O. Never overwrite a concurrent user edit.
      await this.preflight();
      const changes = (await this.git('diff', '--name-only', original, commit)).split('\n');
      dependencyChanged = changes.includes('package-lock.json') || Boolean(history.needsDependencyRepair);
      this.pythonChanged = changes.some(file => /(?:requirements[^/]*\.txt|pyproject\.toml|poetry\.lock)$/.test(file));
      await atomic(historyFile, { ...history, previous: original, target: commit, phase: 'pending' });
      await this.git('checkout', '--no-overwrite-ignore', '--detach', commit);
      switched = true;
      if (dependencyChanged) {
        this.phase = 'install'; needsDependencyRepair = true;
        dependencyStore = new DependencyStore({ cwd: this.cwd, data: this.data, run: this.run });
        dependencyPlan = await dependencyStore.prepare();
        needsDependencyRepair = false;
      }
      this.phase = 'restart';
      handoff = await this.restart({ commit, logFile: this.logFile,
        dependency: dependencyPlan ? { store: dependencyStore, plan: dependencyPlan,
          activate: async () => { dependencyState = await dependencyStore.activate(dependencyPlan); },
          restore: async () => dependencyStore.restore(dependencyState) } : null });
      if (dependencyStore) await dependencyStore.prune(2, [dependencyState?.previousTarget]).catch(() => {});
      await atomic(historyFile, { previous: original, current: commit, phase: 'completed',
        pythonChanged: this.pythonChanged, updatedAt: new Date().toISOString() });
      this.phase = 'completed';
      return { ok: true, commit, pythonChanged: this.pythonChanged };
    } catch (error) {
      this.error = error.message;
      if (switched) {
        try {
          await handoff?.abort?.();
          if (dependencyStore && dependencyState) await dependencyStore.restore(dependencyState);
          await this.git('checkout', '--no-overwrite-ignore', '--detach', original);
          if (dependencyChanged) {
            needsDependencyRepair = true;
            const restoreStore = new DependencyStore({ cwd: this.cwd, data: this.data, run: this.run });
            await restoreStore.prepare();
            needsDependencyRepair = false;
          }
          this.error += '；已恢复原版本';
        } catch (recovery) { this.error += `；恢复未完成：${recovery.message}`; }
      }
      if (lock) await atomic(historyFile, { ...(await readJson(historyFile, {})),
        phase: 'failed', error: this.error, needsDependencyRepair });
      this.phase = 'failed';
      throw new Error(this.error);
    } finally {
      this.updating = false;
      if (lock) { await lock.close(); await unlink(path.join(this.data, 'update.lock')); }
      if (this.phase === 'completed') handoff?.finish?.();
    }
  }
}
