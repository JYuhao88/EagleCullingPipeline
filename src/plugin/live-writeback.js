export const LIVE_KEYS = { enabled: 'eagle-culling-live-writeback', star: 'eagle-culling-live-star',
  folders: 'eagle-culling-smart-folders' };
const FOLDER_KEY = 'eagle-culling-smart-folders-created';

export async function ensureSmartFolders(eagle, storage, onNotice = () => {}, options = {}) {
  if (!options.force && (storage?.getItem(LIVE_KEYS.enabled) !== '1' || storage?.getItem(LIVE_KEYS.folders) === '0')) return;
  const sf = eagle?.smartFolder;
  if (!sf?.create || !sf?.getAll || !sf?.getRules) {
    if (storage?.getItem(FOLDER_KEY) !== 'unsupported') onNotice('当前 Eagle 版本不支持自动创建智能文件夹');
    storage?.setItem(FOLDER_KEY, 'unsupported'); return;
  }
  const library = eagle?.library?.id || eagle?.library?.path || 'default';
  if (storage?.getItem(FOLDER_KEY) === library) return;
  const schema = await sf.getRules();
  const method = schema?.tags?.methods?.includes('contain') ? 'contain' : null;
  if (!method) { onNotice('当前 Eagle 标签筛选规则不支持自动创建智能文件夹'); return; }
  const folders = await sf.getAll();
  const names = [['AI精选', 'AI精选'], ['AI待淘汰', 'AI淘汰']];
  if (options.includeProblemFolders) names.push(['AI 建议淘汰', 'AI淘汰'], ['AI 闭眼', 'AI闭眼'], ['AI 模糊', 'AI模糊']);
  for (const [name, tag] of names) {
    if (folders.some(folder => folder.name === name)) continue;
    const value = schema.tags.valueType === 'array' ? [tag] : tag;
    const rule = sf.rule?.('tags')?.[method]?.(value) || { property: 'tags', method, value };
    await sf.create({ name, conditions: [sf.Condition?.create?.('AND', [rule]) || { match: 'AND', rules: [rule] }] });
  }
  storage?.setItem(FOLDER_KEY, library);
}

// Decision persistence owns success. This queue only handles nonblocking Eagle updates.
export function createLiveWriteback({ api, storage = globalThis.localStorage, delay = 500,
  onStatus = () => {}, onApplied = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map();
  let timer = null, tail = Promise.resolve(), failed = false;
  const enabled = () => storage?.getItem(LIVE_KEYS.enabled) === '1';
  function schedule(runId, unitIds) {
    if (!enabled() || !runId) return;
    const ids = pending.get(runId) || new Set();
    unitIds.forEach(id => ids.add(id)); pending.set(runId, ids);
    clearTimer(timer); timer = setTimer(() => { timer = null; void flush(); }, delay);
  }
  function flush() {
    clearTimer(timer); timer = null;
    if (!enabled()) { pending.clear(); return tail; }
    const batches = [...pending].map(([runId, ids]) => [runId, [...ids]]); pending.clear();
    tail = tail.then(async () => {
      for (const [runId, unitIds] of batches) {
        if (!enabled()) continue;
        try {
          const result = await api(`/runs/${encodeURIComponent(runId)}/writeback/live`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unitIds, star: storage?.getItem(LIVE_KEYS.star) === '1' })
          });
          if (result.results?.some(row => row.ok === true)) onApplied(runId, result);
          if (result.results?.some(row => row.ok === false)) throw new Error('部分照片未写回');
          failed = false; onStatus('实时写回已开启', false);
        } catch (error) {
          const retry = pending.get(runId) || new Set(); unitIds.forEach(id => retry.add(id)); pending.set(runId, retry);
          if (!failed) onStatus(`实时写回失败：${error.message}（点击重试）`, true);
          failed = true;
        }
      }
    });
    return tail;
  }
  function cancel() { clearTimer(timer); timer = null; pending.clear(); return tail.then(() => pending.clear()); }
  return { schedule, flush, cancel, enabled };
}

export function bindLiveWriteback({ root, api, getRunId, storage = globalThis.localStorage, eagle = globalThis.eagle }) {
  const indicator = root.querySelector('#liveIndicator');
  const status = root.querySelector('#liveWritebackStatus');
  const notice = message => { status.textContent = message; };
  const controller = createLiveWriteback({ api, storage,
    onStatus(message, error) { indicator.hidden = !controller.enabled(); indicator.textContent = message;
      indicator.classList.toggle('error', error); },
    onApplied(runId) { if (runId === getRunId()) root.querySelector('#revertWriteback').hidden = false; }
  });
  let lastEnabled = false;
  function sync() {
    for (const [id, key] of [['liveWritebackToggle', LIVE_KEYS.enabled],
      ['liveStarToggle', LIVE_KEYS.star], ['smartFoldersToggle', LIVE_KEYS.folders]]) {
      const input = root.querySelector(`#${id}`);
      input.checked = key === LIVE_KEYS.folders ? storage?.getItem(key) !== '0' : storage?.getItem(key) === '1';
      if (key !== LIVE_KEYS.enabled) input.disabled = !controller.enabled();
    }
    indicator.hidden = !controller.enabled();
    if (!indicator.classList.contains('error')) indicator.textContent = '实时写回已开启';
    if (controller.enabled() && !lastEnabled) {
      void ensureSmartFolders(eagle, storage, notice).catch(error => notice(`智能文件夹创建失败：${error.message}`));
    }
    lastEnabled = controller.enabled();
    if (!controller.enabled()) void controller.cancel();
  }
  for (const [id, key] of [['liveWritebackToggle', LIVE_KEYS.enabled],
      ['liveStarToggle', LIVE_KEYS.star], ['smartFoldersToggle', LIVE_KEYS.folders]]) {
    root.querySelector(`#${id}`).addEventListener('change', event => {
      storage?.setItem(key, event.target.checked ? '1' : '0'); sync();
    });
  }
  indicator.addEventListener('click', () => { void controller.flush(); });
  root.querySelector('#reviewMore').addEventListener('toggle', sync);
  globalThis.addEventListener?.('storage', sync);
  // Same-window home settings also update the indicator when entering review.
  sync();
  return { ...controller, sync };
}
