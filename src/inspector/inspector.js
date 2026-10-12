import { initEagleTheme } from '../plugin/theme.js';
import { percentScore } from '../plugin/score.js';
export function inspectorModel({ state, result } = {}) {
  if (state !== 'result') return { badge: { loading: '加载中…', offline: '分析服务未运行',
    empty: '尚未分析，在插件中分析后显示' }[state] || '尚未分析，在插件中分析后显示', lines: [], reasons: [] };
  const action = { selected: '精选', candidate: '候选', rejected: '淘汰' };
  return { tone: action[result.action] ? result.action : 'candidate', currentAction: result.humanDecided ? result.action : null,
    tagsOn: result.eagleTagsEnabled === true, groupId: result.groupId, groupItemIds: result.groupItemIds || [],
    bestItemId: result.bestItemId || null, groupIndex: result.groupIndex, selectedCount: result.selectedCount || 1,
    badge: `${action[result.action] || '候选'} · ${result.humanDecided ? '已人工决定' : '建议'}`,
    lines: [`第 ${result.rank ?? '—'} / ${result.groupSize} 张 · 总分 ${percentScore(result.score)} · `
      + `质量 ${percentScore(result.quality)}`,
      `对焦 ${result.focus}${result.eyeSharpness == null ? '' : ` · 眼部清晰度 ${Math.round(result.eyeSharpness)}`}`,
      (result.flags || []).map(flag => ({ 'eyes-closed': '闭眼', 'eyes-uncertain': '闭眼待复核',
        blurry: '模糊', 'possibly-blurry': '可能模糊', noisy: '噪点', overexposed: '过曝',
        underexposed: '欠曝' }[flag] || flag)).join(' · '),
      `${result.runName} · ${result.analyzedAt
        ? new Date(result.analyzedAt).toLocaleString('zh-CN') : '时间未记录'}`].filter(Boolean),
    reasons: [...(result.reasons || []), ...(result.humanReason ? [`人工理由：${result.humanReason}`] : [])] };
}
const ADVANCE_KEY = 'eagle-culling-inspector-advance';
// Next queue row after the current unit in group/rank order, wrapping; never the current unit itself.
export function nextInQueue(rows, unitId, order = null) {
  const candidates = rows.filter(row => row.primaryItemId && row.unitId !== unitId);
  if (!candidates.length) return null;
  const all = order || rows.map(row => row.unitId);
  const position = all.indexOf(unitId);
  if (position < 0) return candidates[0];
  const rank = id => { const index = all.indexOf(id); return index > position ? index - position : index + all.length - position; };
  return candidates.reduce((best, row) => rank(row.unitId) < rank(best.unitId) ? row : best);
}
export function mountInspector({ root = document, eagle = globalThis.eagle, storage = localStorage, fetchImpl = fetch } = {}) {
  void initEagleTheme({ eagle, doc: root });
  let version = 0, timer, visible = !root.hidden, disposed = false, lastKey = '', lastFetch = 0;
  let current = { state: 'empty', result: null, selected: [] };
  function render(state, result, selected = current.selected) {
    current = { state, result, selected };
    const model = inspectorModel({ state, result });
    const status = root.querySelector('#status');
    status.textContent = model.badge;
    if (status.dataset) status.dataset.tone = model.tone || '';
    const lines = root.querySelector('#lines'); lines.replaceChildren();
    for (const text of model.lines) { const row = root.createElement('p'); row.textContent = text; lines.append(row); }
    root.querySelector('#reasons').textContent = model.reasons.join('；');
    root.querySelector('#details').hidden = !model.reasons.length;
    const count = root.querySelector('#selectedCount');
    if (count) count.textContent = selected.length > 1 ? `已选 ${selected.length} 张` : '';
    for (const button of root.querySelectorAll?.('[data-decision]') || []) {
      button.classList.toggle('active', model.currentAction === button.dataset.decision);
      button.disabled = state !== 'result';
    }
    const group = root.querySelector('#groupContext');
    if (group) group.textContent = model.groupId ? `本组 ${model.groupItemIds.length} 张 · 第 ${result.rank ?? '—'} 名` : '';
    const tags = root.querySelector('#tagsState');
    if (tags) tags.textContent = model.tagsOn ? 'AI 标签已开启' : 'AI 标签未开启';
    const fallback = root.querySelector('#eagleFallback');
    if (fallback) fallback.hidden = Boolean(eagle?.item?.select);
  }
  async function refresh(force = false) {
    if (!visible || disposed) return;
    let token = version;
    try {
      const selected = await eagle?.item?.getSelected?.() || [];
      if (token !== version) return;
      const item = selected[0] || null;
      const base = storage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125';
      const libraryPath = eagle?.library?.path || '';
      const key = JSON.stringify([base, libraryPath, selected.map(candidate => candidate.id || candidate)]);
      if (!force && lastKey === key && Date.now() - lastFetch < 15000) return;
      token = ++version; lastKey = key; lastFetch = Date.now();
      if (!item) { render('empty', null, []); return; }
      render('loading', null, selected);
      const response = await
        fetchImpl(`${base.replace(/\/$/, '')}/items/${encodeURIComponent(item.id)}/analysis?libraryPath=${encodeURIComponent(libraryPath)}`,
        { signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (token !== version || disposed || !visible) return;
      if (response.ok) result.selectedCount = selected.length;
      render(response.ok ? 'result' : response.status === 404 ? 'empty' : 'offline', result, selected);
    } catch { if (token === version && !disposed && visible) render('offline'); }
  }
  async function poll() {
    await refresh();
    if (visible && !disposed) timer = setTimeout(poll, 1500);
  }
  function setVisible(value) { visible = value; version++; clearTimeout(timer); if (value) { lastKey = ''; void poll(); } }
  async function decide(action) {
    if (current.state !== 'result' || !current.selected.length) return;
    const before = current.result;
    const optimistic = { ...before, action: action === 'clear' ? before.suggested : action,
      humanDecided: action !== 'clear' };
    render('result', optimistic, current.selected);
    const base = storage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125';
    const libraryPath = eagle?.library?.path || '';
    try {
      await Promise.all(current.selected.map(item => {
        const path = `${base.replace(/\/$/, '')}/items/${encodeURIComponent(item.id)}/decision`;
        const query = `?libraryPath=${encodeURIComponent(libraryPath)}`;
        return fetchImpl(path + query, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ libraryPath, action }) }).then(response => {
            if (!response.ok) throw new Error('决定保存失败'); return response;
          });
      }));
      lastKey = ''; lastFetch = 0;
      if (storage.getItem(ADVANCE_KEY) === '1' && current.selected.length === 1) await navigate('undecided');
      else await refresh(true);
    } catch (error) {
      render('result', before, current.selected);
      const status = root.querySelector('#status');
      if (status) status.textContent = `保存失败：${error.message}`;
    }
  }
  for (const button of root.querySelectorAll?.('[data-decision]') || [])
    button.addEventListener?.('click', () => void decide(button.dataset.decision));
  root.querySelector('#selectGroup')?.addEventListener?.('click', () => {
    const ids = current.result?.groupItemIds || []; if (ids.length && eagle?.item?.select) void eagle.item.select(ids);
  });
  root.querySelector('#selectBest')?.addEventListener?.('click', () => {
    const id = current.result?.bestItemId; if (id && eagle?.item?.select) void eagle.item.select([id]);
  });
  async function navigate(mode) {
    const base = storage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125';
    const runId = current.result?.runId; if (!runId) return;
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/queue?mode=${mode}`);
      const body = await response.json();
      const next = nextInQueue(body.queue || body.items || [], current.result?.unitId, body.order);
      if (next && eagle?.item?.select) await eagle.item.select([next.primaryItemId]);
    } catch { /* panel remains usable when navigation is offline */ }
  }
  const advance = root.querySelector('#autoAdvance');
  if (advance) {
    advance.checked = storage.getItem(ADVANCE_KEY) === '1';
    advance.addEventListener?.('change', () => storage.setItem(ADVANCE_KEY, advance.checked ? '1' : '0'));
  }
  root.querySelector('#nextUndecided')?.addEventListener?.('click', () => void navigate('undecided'));
  root.querySelector('#nextReject')?.addEventListener?.('click', () => void navigate('rejects'));
  root.addEventListener?.('keydown', event => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    const action = { '1': 'selected', '2': 'candidate', '3': 'rejected', '0': 'clear' }[event.key];
    if (action) { event.preventDefault(); void decide(action); }
  });
  eagle?.onPluginCreate?.(() => setVisible(true));
  eagle?.onPluginShow?.(() => setVisible(true));
  eagle?.onPluginHide?.(() => setVisible(false));
  eagle?.onLibraryChanged?.(() => { lastKey = ''; version++; if (visible) void refresh(true); });
  root.addEventListener?.('visibilitychange', () => setVisible(!root.hidden));
  if (visible) void poll();
  globalThis.addEventListener?.('pagehide', () => { disposed = true; version++; clearTimeout(timer); });
  return { refresh, setVisible, dispose() { disposed = true; version++; clearTimeout(timer); } };
}
if (typeof document !== 'undefined' && document.querySelector('#inspector')) mountInspector();
