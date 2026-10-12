import { initEagleTheme } from '../plugin/theme.js';
import { percentScore } from '../plugin/score.js';
export function inspectorModel({ state, result } = {}) {
  if (state !== 'result') return { badge: { loading: '加载中…', offline: '分析服务未运行',
    empty: '尚未分析，在插件中分析后显示' }[state] || '尚未分析，在插件中分析后显示', lines: [], reasons: [] };
  const action = { selected: '精选', candidate: '候选', rejected: '淘汰' };
  return { tone: action[result.action] ? result.action : 'candidate',
    badge: `${action[result.action] || '候选'} · ${result.humanDecided ? '已人工决定' : '建议'}`,
    lines: [`第 ${result.rank ?? '—'} / ${result.groupSize} 张 · 总分 ${percentScore(result.score)} · 质量 ${percentScore(result.quality)}`,
      `对焦 ${result.focus}${result.eyeSharpness == null ? '' : ` · 眼部清晰度 ${Math.round(result.eyeSharpness)}`}`,
      (result.flags || []).map(flag => ({ 'eyes-closed': '闭眼', 'eyes-uncertain': '闭眼待复核',
        blurry: '模糊', 'possibly-blurry': '可能模糊', noisy: '噪点', overexposed: '过曝', underexposed: '欠曝' }[flag] || flag)).join(' · '),
      `${result.runName} · ${result.analyzedAt ? new Date(result.analyzedAt).toLocaleString('zh-CN') : '时间未记录'}`].filter(Boolean),
    reasons: [...(result.reasons || []), ...(result.humanReason ? [`人工理由：${result.humanReason}`] : [])] };
}
export function mountInspector({ root = document, eagle = globalThis.eagle, storage = localStorage, fetchImpl = fetch } = {}) {
  void initEagleTheme({ eagle, doc: root });
  let version = 0, timer, visible = !root.hidden, disposed = false, lastKey = '', lastFetch = 0;
  function render(state, result) {
    const model = inspectorModel({ state, result });
    const status = root.querySelector('#status');
    status.textContent = model.badge;
    if (status.dataset) status.dataset.tone = model.tone || '';
    const lines = root.querySelector('#lines'); lines.replaceChildren();
    for (const text of model.lines) { const row = root.createElement('p'); row.textContent = text; lines.append(row); }
    root.querySelector('#reasons').textContent = model.reasons.join('；');
    root.querySelector('#details').hidden = !model.reasons.length;
  }
  async function refresh(force = false) {
    if (!visible || disposed) return;
    let token = version;
    try {
      const selected = await eagle?.item?.getSelected?.() || [];
      if (token !== version) return;
      const item = selected.length === 1 ? selected[0] : null;
      const base = storage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125';
      const libraryPath = eagle?.library?.path || '';
      const key = JSON.stringify([base, libraryPath, item?.id]);
      if (!force && lastKey === key && Date.now() - lastFetch < 15000) return;
      token = ++version; lastKey = key; lastFetch = Date.now();
      if (!item) { render('empty'); return; }
      render('loading');
      const response = await
        fetchImpl(`${base.replace(/\/$/, '')}/items/${encodeURIComponent(item.id)}/analysis?libraryPath=${encodeURIComponent(libraryPath)}`,
        { signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (token !== version || disposed || !visible) return;
      render(response.ok ? 'result' : response.status === 404 ? 'empty' : 'offline', result);
    } catch { if (token === version && !disposed && visible) render('offline'); }
  }
  async function poll() {
    await refresh();
    if (visible && !disposed) timer = setTimeout(poll, 1500);
  }
  function setVisible(value) { visible = value; version++; clearTimeout(timer); if (value) { lastKey = ''; void poll(); } }
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
