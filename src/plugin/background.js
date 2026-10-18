import { serviceOptions, serviceLaunch } from './service-start.js';
import { completionText } from './start-model.js';
export function shouldAutoStart({ connected, enabled, base, repository, launching = false }) {
  if (connected || !enabled || launching || !repository) return false;
  try { serviceOptions(repository, base); return true; } catch { return false; }
}
export function portOccupied(base, requireImpl = globalThis.require) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = requireImpl('node:net').createConnection({ host: url.hostname, port: Number(url.port || 80) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => { if (error.code === 'ECONNREFUSED') finish(false); else { socket.destroy(); reject(error); } });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('无法确认端口是否空闲')); });
  });
}
// Apps started from the Dock or Finder get PATH=/usr/bin:/bin:/usr/sbin:/sbin, which misses every usual Node install.
const POSIX_NODE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
export function launchEnv(env = {}, platform = 'darwin', listDir = () => []) {
  if (platform === 'win32') return { ...env };
  const home = env.HOME || '';
  let nvm = [];
  try {
    nvm = listDir(`${home}/.nvm/versions/node`).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map(version => `${home}/.nvm/versions/node/${version}/bin`);
  } catch { /* no nvm */ }
  const extra = [...POSIX_NODE_DIRS, ...(home ? [`${home}/.volta/bin`, `${home}/.local/bin`, ...nvm] : [])];
  const current = String(env.PATH || '').split(':').filter(Boolean);
  return { ...env, PATH: [...new Set([...current, ...extra])].join(':') };
}
export async function launchLocalService({ repository, base, requireImpl = globalThis.require, occupied = portOccupied, allowed =
  () => true, env = globalThis.process?.env || {}, earlyExitMs = 1500 }) {
  const options = serviceLaunch(repository, base);
  if (await occupied(base, requireImpl)) throw new Error('端口已被占用，请检查诊断中的服务地址');
  if (!allowed()) throw new Error('自动启动已关闭');
  const platform = options.command === 'node' ? 'win32' : 'posix';
  const listDir = path => requireImpl('node:fs').readdirSync(path);
  const child = requireImpl('node:child_process').spawn(options.command, options.args,
    { cwd: options.cwd, detached: true, stdio: 'ignore', windowsHide: true, env: launchEnv(env, platform, listDir) });
  let exitCode = null, timer = null, onExit = () => {};
  child.once('exit', value => { exitCode = value ?? -1; onExit(); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  const code = exitCode !== null ? exitCode : await new Promise(resolve => {
    timer = setTimeout(() => resolve(null), earlyExitMs);
    onExit = () => { clearTimeout(timer); resolve(exitCode); };
  });
  if (code === 127) throw new Error('找不到 Node.js：请安装 Node 20+（Homebrew、nvm 或官网安装包均可）');
  if (code !== null) throw new Error(`服务启动后立即退出（退出码 ${code}），请在设置 › 高级复制启动命令到终端运行查看原因`);
  if (options.command === 'node' && child.pid) {
    try { const os = requireImpl('node:os'); os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
    catch { /* Node still runs if priority adjustment is unavailable. */ }
  }
  child.unref();
  return child;
}
export function createRunNotifier({ storage, eagle = globalThis.eagle, base = () => '' }) {
  const key = () => `eagle-culling-notified:${base()}`;
  return async run => {
    if (!['completed', 'failed'].includes(run.status) || run.purpose === 'prefetch') return false;
    let ids; try { ids = JSON.parse(storage.getItem(key()) || '[]'); } catch { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    if (ids.includes(run.id)) return false;
    // Persist before invoking the host so a reload never repeats a notification.
    storage.setItem(key(), JSON.stringify([...ids, run.id]));
    if (!eagle?.notification?.show) return false;
    try {
      await eagle.notification.show({ title: run.status === 'completed' ? '照片分析完成' : '照片分析失败',
        body: run.status === 'completed' ? `${completionText(run)}，打开插件开始审阅`
          : String(run.error || '请打开插件重试').slice(0, 120), mute: false, duration: 5000 });
      return true;
    } catch { return false; }
  };
}
export const RELOAD_KEY = 'eagle-culling-reloaded';
export function mountBackgroundLifecycle({ eagle = globalThis.eagle, win = globalThis.window, onVisible, onCreate,
  onOpen = () => {}, loadedHidden = false }) {
  let shown = false, runs = 0;
  const visible = value => { shown = value; onVisible(value); };
  const reloaded = win?.sessionStorage?.getItem(RELOAD_KEY);
  const quiet = loadedHidden || reloaded === '0';
  eagle?.onPluginCreate?.(() => { visible(false); void onCreate(); });
  // Eagle sends plugin-run once for loading the page and again for every open from its plugin menu. A page loaded
  // into a hidden window must leave it hidden.
  eagle?.onPluginRun?.(() => {
    const opened = runs++ > 0;
    if (!opened && quiet) return;
    void Promise.resolve(eagle.window?.show?.()).catch(() => {}); visible(true);
    if (opened) onOpen();
  });
  eagle?.onPluginShow?.(() => visible(true));
  eagle?.onPluginHide?.(() => visible(false));
  if (win && eagle?.window?.hide) win.onbeforeunload = event => {
    if (win.__ecAllowUnload) return;
    visible(false); void Promise.resolve(eagle.window.hide()).catch(() => {});
    event.returnValue = false; return false;
  };
  // A reloaded page gets no create/show events from Eagle; restore what it was before reloading.
  if (reloaded === '0' || reloaded === '1') {
    win.sessionStorage.removeItem(RELOAD_KEY); visible(reloaded === '1'); void onCreate();
  }
  return {
    isShown: () => shown,
    reload() {
      win?.sessionStorage?.setItem(RELOAD_KEY, shown ? '1' : '0');
      if (win) win.__ecAllowUnload = true;
      win?.location?.reload();
    }
  };
}
