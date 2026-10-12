export const PREFETCH_WINDOW_KEY = 'eagle-culling-idle-window';
export const DEFAULT_WINDOW = '01:00-07:00';
export const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'heic', 'heif', 'arw', 'dng', '3fr', 'cr2', 'cr3',
  'nef', 'raf', 'orf', 'rw2']);
const minutes = text => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};
export function parseWindow(text = DEFAULT_WINDOW) {
  const [start, end] = String(text).split('-').map(minutes);
  if (start == null || end == null || start === end) return parseWindow(DEFAULT_WINDOW);
  return { start, end };
}
export function inWindow(date, text) {
  const { start, end } = parseWindow(text), now = date.getHours() * 60 + date.getMinutes();
  // A window such as 23:00-06:00 crosses midnight.
  return start < end ? now >= start && now < end : now >= start || now < end;
}
export function prefetchDecision({ enabled, now, window, visible, idleSeconds, onBattery, connected, busy }) {
  if (!enabled) return { run: false, reason: '未开启' };
  if (!connected) return { run: false, reason: '服务未连接' };
  if (busy) return { run: false, reason: '已有分析在进行' };
  if (!inWindow(now, window)) return { run: false, reason: '不在预处理时段' };
  if (visible) return { run: false, reason: '插件窗口正在使用' };
  if (onBattery !== false) return { run: false, reason: onBattery ? '使用电池供电' : '无法确认电源状态' };
  if (Number.isFinite(idleSeconds) && idleSeconds < 600) return { run: false, reason: '电脑正在使用' };
  return { run: true, reason: '' };
}
export function shouldCancelPrefetch({ now, window, visible, idleSeconds, onBattery }) {
  return Boolean(visible || onBattery !== false || Number.isFinite(idleSeconds) && idleSeconds < 60 || !inWindow(now, window));
}
function darwinIdleSeconds(requireImpl) {
  return new Promise(resolve => {
    try {
      requireImpl('node:child_process').execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'],
        { timeout: 3000, windowsHide: true }, (error, stdout) => {
          const match = !error && /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout));
          resolve(match ? Number(match[1]) / 1e9 : null);
        });
    } catch { resolve(null); }
  });
}
export async function systemSignals({ requireImpl = globalThis.require, nav = globalThis.navigator,
  platform = globalThis.process?.platform } = {}) {
  let monitor = null;
  try { monitor = requireImpl?.('electron')?.powerMonitor || null; } catch { /* Renderer plugins may not expose Electron. */ }
  let idleSeconds = null, onBattery = null;
  try { if (monitor?.getSystemIdleTime) idleSeconds = monitor.getSystemIdleTime(); } catch { /* Unknown idle time. */ }
  if (idleSeconds == null && platform === 'darwin' && typeof requireImpl === 'function') idleSeconds = await darwinIdleSeconds(requireImpl);
  try {
    if (monitor?.isOnBatteryPower) onBattery = Boolean(monitor.isOnBatteryPower());
    else if (nav?.getBattery) onBattery = !(await nav.getBattery()).charging;
  } catch { onBattery = null; }
  return { idleSeconds, onBattery };
}
export async function prefetchCandidates({ eagle, now = Date.now(), days = 30, limit = 300, analyzed = async () => [] }) {
  const cutoff = now - days * 86400000;
  let rows;
  if (eagle?.item?.getIdsWithModifiedAt && eagle.item.getByIds) {
    const ids = (await eagle.item.getIdsWithModifiedAt()).filter(row => row.modifiedAt >= cutoff)
      .sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 1000).map(row => row.id);
    rows = ids.length ? await eagle.item.getByIds(ids) : [];
  } else if (eagle?.item?.get) rows = await eagle.item.get({ fields: ['id', 'ext', 'importedAt', 'isDeleted'] });
  else return [];
  const recent = (rows || []).filter(item => item?.id && !item.isDeleted && item.importedAt >= cutoff &&
    IMAGE_EXTENSIONS.has(String(item.ext || '').toLowerCase())).sort((a, b) => b.importedAt - a.importedAt).slice(0, 1000)
    .map(item => item.id);
  if (!recent.length) return [];
  const done = new Set(await analyzed(recent));
  return recent.filter(id => !done.has(id)).slice(0, limit);
}
export function createIdlePrefetcher({ storage, getApi, eagle = globalThis.eagle, isVisible, isConnected, isBusy = () => false,
  readSignals = systemSignals, clock = () => new Date(), enabled = () => storage.getItem('eagle-culling-idle-prefetch') === '1' }) {
  let timer = null, lastAttempt = -Infinity, running = false, ownRun = null;
  const window = () => storage.getItem(PREFETCH_WINDOW_KEY) || DEFAULT_WINDOW;
  const post = (path, body) => getApi()(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}) });
  async function tick({ force = false } = {}) {
    if (running) return { action: 'busy' };
    running = true;
    try {
      if (!enabled() && !ownRun && !force) return { action: 'skip', reason: '未开启' };
      if (!isConnected()) return { action: 'skip', reason: '服务未连接' };
      const status = await getApi()('/runs/status');
      const now = clock(), signals = await readSignals();
      if (status.prefetch?.status !== 'running') ownRun = null;
      if (status.prefetch?.status === 'running') {
        if (!enabled() || shouldCancelPrefetch({ now, window: window(), visible: isVisible(), ...signals })) {
          await post(`/runs/${status.prefetch.id}/cancel`);
          ownRun = null;
          return { action: 'cancelled' };
        }
        return { action: 'running' };
      }
      if (!force && now.getTime() - lastAttempt < CHECK_INTERVAL_MS) return { action: 'wait' };
      const decision = prefetchDecision({ enabled: enabled(), now, window: window(), visible: isVisible(), ...signals,
        connected: true, busy: Boolean(status.active) || isBusy() });
      if (!decision.run) return { action: 'skip', reason: decision.reason };
      lastAttempt = now.getTime();
      const libraryPath = eagle?.library?.path;
      if (!libraryPath) return { action: 'skip', reason: '未打开资源库' };
      const itemIds = await prefetchCandidates({ eagle, now: now.getTime(), analyzed: async ids =>
        (await post('/runs/analyzed', { itemIds: ids, libraryPath })).itemIds || [] });
      if (!itemIds.length) return { action: 'skip', reason: '没有待预处理的新照片' };
      const run = await post('/runs', { purpose: 'prefetch', libraryPath, itemIds,
        scope: { type: 'selection', label: '空闲预处理' } });
      ownRun = run.id;
      return { action: 'started', runId: run.id, count: itemIds.length };
    } catch (error) {
      return { action: 'error', reason: error.message };
    } finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, 60000); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
