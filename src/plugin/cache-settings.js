import { DEFAULT_WINDOW, PREFETCH_WINDOW_KEY, parseWindow } from './idle-prefetch.js';
const GB = 1024 ** 3;
export const CACHE_LIMITS_GB = [2, 5, 10, 20, 50];
export function formatBytes(bytes = 0) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
export function usageText(usage) {
  return `缓存占用 ${formatBytes(usage.totalBytes)} / 上限 ${formatBytes(usage.maxBytes)}`;
}
export function prefetchText(prefetch) {
  if (!prefetch) return '尚未预处理';
  if (prefetch.status === 'running') return '正在空闲预处理…';
  const when = new Date(prefetch.finishedAt || prefetch.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit' });
  const state = { completed: '完成', cancelled: '已暂停', failed: '失败' }[prefetch.status] || prefetch.status;
  return `上次预处理：${when} · ${prefetch.itemCount || 0} 张 · ${state}`;
}
const pad = value => String(value).padStart(2, '0');
const clockText = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
export function mountCacheSettings({ root, getApi, storage = globalThis.localStorage, confirmImpl = text => globalThis.confirm(text) }) {
  const q = id => root.querySelector(`#${id}`);
  const status = text => { if (q('cacheUsage')) q('cacheUsage').textContent = text; };
  const post = (path, body) => getApi()(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  let busy = false;
  const setBusy = value => {
    busy = value;
    for (const id of ['cacheLimit', 'clearPreviewCache', 'clearAllCache']) if (q(id)) q(id).disabled = value;
  };
  async function refresh() {
    try {
      const usage = await getApi()('/cache/usage');
      status(usageText(usage));
      const limit = q('cacheLimit');
      if (limit) {
        const gb = Math.round(usage.maxBytes / GB);
        if (![...limit.options].some(option => Number(option.value) === gb)) limit.append(new Option(`${gb} GB`, String(gb)));
        limit.value = String(gb);
      }
    } catch { status('服务未连接，无法读取缓存占用'); }
    try { if (q('prefetchLast')) q('prefetchLast').textContent = prefetchText((await getApi()('/runs/status')).prefetch); }
    catch { if (q('prefetchLast')) q('prefetchLast').textContent = ''; }
  }
  async function action(run, pending) {
    if (busy) return;
    setBusy(true); status(pending);
    try { status(usageText(await run())); }
    catch (error) {
      status(error.status === 409 ? '分析进行中，完成后再清理' : `操作失败：${error.message}`);
    } finally { setBusy(false); }
  }
  q('cacheLimit')?.addEventListener('change', () => action(async () => {
    await post('/cache/limit', { maxBytes: Number(q('cacheLimit').value) * GB });
    return getApi()('/cache/usage');
  }, '正在保存上限…'));
  q('clearPreviewCache')?.addEventListener('click', () => action(() => post('/cache/clear', { scope: 'derived' }),
    '正在清理预览缓存…'));
  q('clearAllCache')?.addEventListener('click', () => {
    if (!confirmImpl('清空全部缓存后，下次分析需要重新计算，会明显变慢。确定清空？')) return;
    void action(() => post('/cache/clear', { scope: 'all' }), '正在清空缓存…');
  });
  const { start, end } = parseWindow(storage.getItem(PREFETCH_WINDOW_KEY) || DEFAULT_WINDOW);
  if (q('idleWindowStart')) q('idleWindowStart').value = clockText(start);
  if (q('idleWindowEnd')) q('idleWindowEnd').value = clockText(end);
  const saveWindow = () => {
    const text = `${q('idleWindowStart')?.value}-${q('idleWindowEnd')?.value}`;
    const parsed = parseWindow(text);
    storage.setItem(PREFETCH_WINDOW_KEY, `${clockText(parsed.start)}-${clockText(parsed.end)}`);
  };
  for (const id of ['idleWindowStart', 'idleWindowEnd']) q(id)?.addEventListener('change', saveWindow);
  q('openSettings')?.addEventListener('click', () => { void refresh(); });
  return { refresh };
}
