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
export async function launchLocalService({ repository, base, requireImpl = globalThis.require, occupied = portOccupied, allowed =
  () => true }) {
  const options = serviceLaunch(repository, base);
  if (await occupied(base, requireImpl)) throw new Error('端口已被占用，请检查诊断中的服务地址');
  if (!allowed()) throw new Error('自动启动已关闭');
  const child = requireImpl('node:child_process').spawn(options.command, options.args,
    { cwd: options.cwd, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
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
export function mountBackgroundLifecycle({ eagle = globalThis.eagle, win = globalThis.window, onVisible, onCreate }) {
  eagle?.onPluginCreate?.(() => { onVisible(false); void onCreate(); });
  eagle?.onPluginRun?.(() => { void Promise.resolve(eagle.window?.show?.()).catch(() => {}); onVisible(true); });
  eagle?.onPluginShow?.(() => onVisible(true));
  eagle?.onPluginHide?.(() => onVisible(false));
  if (win && eagle?.window?.hide) win.onbeforeunload = event => {
    if (win.__ecAllowUnload) return;
    onVisible(false); void Promise.resolve(eagle.window.hide()).catch(() => {});
    event.returnValue = false; return false;
  };
}
