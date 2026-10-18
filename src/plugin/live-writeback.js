export const LIVE_KEYS = { enabled: 'eagle-culling-live-writeback', folders: 'eagle-culling-smart-folders',
  tags: 'eagle-culling-ai-tags' };
const FOLDER_KEY = 'eagle-culling-smart-folders-created';
// Decisions are saved as Eagle stars; writing them as tags too is an opt-in setting, off by default.
export const aiTagsEnabled = storage => storage?.getItem(LIVE_KEYS.tags) === '1';

export async function ensureSmartFolders(eagle, storage, onNotice = () => {}, options = {}) {
  if (!options.force && (!aiTagsEnabled(storage) || storage?.getItem(LIVE_KEYS.enabled) !== '1'
    || storage?.getItem(LIVE_KEYS.folders) === '0')) return;
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
  const enabled = () => aiTagsEnabled(storage) && storage?.getItem(LIVE_KEYS.enabled) === '1';
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
            body: JSON.stringify({ unitIds })
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
