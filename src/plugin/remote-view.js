import { ensureSmartFolders, LIVE_KEYS } from './live-writeback.js';
import { KEY_ACTIONS, FLAG_LABELS, applyDecisionLocally, groupJump, matchesFilter, progress } from './cull-model.js';

const ACTIONS = { selected: '精选', candidate: '候选', rejected: '淘汰' };
const MODES = [['all', '全部'], ['undecided', '未决定'], ['uncertain', '没把握'], ['rejects', '建议淘汰'], ['issues', '有问题']];
const ADVANCE_KEY = 'eagle-culling-remote-advance';
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function moveRemote(items, index, delta, wrap = false) {
  if (!items.length) return -1;
  const next = index + delta;
  return wrap ? (next + items.length) % items.length : Math.max(0, Math.min(items.length - 1, next));
}

export function selectedUnit(items, selectedId) {
  return items.find(row => row.itemIds?.includes(selectedId) || row.primaryItemId === selectedId) || null;
}

export function remotePosition(runId, storage, fallback, valid = () => true) {
  try {
    const saved = JSON.parse(storage?.getItem(`eagle-culling-remote:${runId}`) || 'null');
    return saved && valid(saved.unitId) ? saved : fallback;
  } catch { return fallback; }
}

// Eagle-native culling: the photographer browses in Eagle's own window; this panel follows and records decisions.
export function createRemoteView({ root = document, api, eagle = globalThis.eagle, storage = globalThis.localStorage,
  onExit = () => {}, onOpenFocusedReview = () => {}, onFinish = () => {}, confirmImpl = msg => confirm(msg) } = {}) {
  let runId = null, rows = [], items = [], index = -1, mode = 'all', follow = true, visible = false, timer = null, token = 0;
  let autoAdvance = storage?.getItem(ADVANCE_KEY) !== '0';
  const el = id => root.querySelector(`#${id}`);
  const canSelect = () => typeof eagle?.item?.select === 'function';
  const status = (text, tone = '') => { const node = el('remoteStatus'); if (node) { node.textContent = text; node.dataset.tone = tone; } };

  function save() {
    if (runId && items[index]) storage?.setItem(`eagle-culling-remote:${runId}`, JSON.stringify({ unitId: items[index].unitId, mode }));
  }
  function render() {
    const row = items[index];
    const p = progress(rows);
    el('remoteProgress').textContent = `已决定 ${p.decided} / ${p.total} · 精选 ${p.selected} · 淘汰 ${p.rejected}`;
    el('remoteMeter')?.style.setProperty('--done', p.total ? `${(p.decided / p.total) * 100}%` : '0%');
    for (const [id, label] of MODES) {
      const button = el(`remoteMode-${id}`);
      if (!button) continue;
      button.textContent = `${label} ${rows.filter(item => matchesFilter(item, id)).length}`;
      button.setAttribute('aria-pressed', String(id === mode));
    }
    el('remotePosition').textContent = row ? `${index + 1} / ${items.length}` : '';
    el('remoteCurrent').textContent = row ? row.fileName || row.primaryItemId : '这个筛选下没有照片';
    const flags = (row?.flags || []).map(flag => FLAG_LABELS[flag]).filter(Boolean);
    el('remoteSuggestion').textContent = row ? [`AI 建议${ACTIONS[row.suggested] || '候选'}`,
      row.groupSize > 1 ? `本组 ${row.groupSize} 张中第 ${row.rank}` : '', ...flags, ...(row.reasons || []).slice(0, 2)]
      .filter(Boolean).join(' · ') : '';
    const decision = el('remoteDecision');
    decision.textContent = row?.human ? `你的决定：${ACTIONS[row.human]}` : row ? '还没决定' : '';
    decision.dataset.decision = row?.human || '';
    const image = el('remoteImage');
    const src = row && runId ? `${api.base || ''}/runs/${runId}/preview/${encodeURIComponent(row.unitId)}` : '';
    if (image.dataset.src !== src) { image.dataset.src = src; if (src) image.src = src; else image.removeAttribute('src'); }
    for (const button of root.querySelectorAll('#remote [data-remote-decide]')) {
      button.disabled = !row;
      button.classList.toggle('active', Boolean(row?.human) && row.human === button.dataset.remoteDecide);
    }
    el('remoteFollow').checked = follow;
    el('remoteAdvance').checked = autoAdvance;
    el('remoteSelectNote').hidden = canSelect();
  }
  async function selectCurrent() {
    const row = items[index];
    if (!row || !canSelect()) return false;
    try { await eagle.item.select([row.primaryItemId]); return true; }
    catch (error) { status(`没能在 Eagle 中选中：${error.message}`, 'warn'); return false; }
  }
  function setMode(next) {
    mode = MODES.some(([id]) => id === next) ? next : 'all';
    const keep = items[index]?.unitId;
    items = rows.filter(row => matchesFilter(row, mode));
    index = items.findIndex(row => row.unitId === keep);
    if (index < 0) index = Math.max(0, items.findIndex(row => !row.human));
    if (!items.length) index = -1;
    render(); save(); void selectCurrent();
  }
  async function load() {
    const current = ++token;
    status('正在读取…');
    try {
      const [queue, run] = await Promise.all([api(`/runs/${runId}/queue?mode=all`), api(`/runs/${runId}`).catch(() => null)]);
      if (current !== token) return;
      rows = queue.queue || queue.items || [];
      el('remoteTitle').textContent = run?.scope?.label || '挑片';
      el('remoteTags').checked = run?.eagleTagsEnabled === true;
      const saved = remotePosition(runId, storage, { unitId: null, mode: 'all' }, id => rows.some(row => row.unitId === id));
      mode = MODES.some(([id]) => id === saved.mode) ? saved.mode : 'all';
      items = rows.filter(row => matchesFilter(row, mode));
      index = items.findIndex(row => row.unitId === saved.unitId);
      if (index < 0) index = Math.max(0, items.findIndex(row => !row.human));
      if (!items.length) index = -1;
      status(canSelect() ? '在 Eagle 里浏览照片，这里会跟着显示 AI 建议；用 1/2/3 记录决定。' : '');
      render(); save(); await selectCurrent();
    } catch (error) {
      if (current === token) status(`读取失败：${error.message}`, 'error');
    }
  }
  async function decide(action) {
    const row = items[index];
    if (!row) return;
    const before = row.human;
    applyDecisionLocally(row, action);
    if (autoAdvance && action !== 'clear' && index < items.length - 1) index += 1;
    render(); save(); void selectCurrent();
    try {
      const result = await api(`/runs/${runId}/decisions`, json({ decisions: [action === 'clear'
        ? { unitId: row.unitId, clear: true } : { unitId: row.unitId, action }] }));
      status(result?.tagWarning ? `已保存；Eagle 标签没更新：${result.tagWarning}` : `${row.fileName || '照片'}：${ACTIONS[action] || '恢复 AI 建议'}`,
        result?.tagWarning ? 'warn' : '');
    } catch (error) {
      applyDecisionLocally(row, before || 'clear');
      render();
      status(`没有保存：${error.message}`, 'error');
    }
  }
  function move(delta) { if (!items.length) return; index = moveRemote(items, index, delta); render(); save(); void selectCurrent(); }
  function jumpGroup(delta) { if (!items.length) return; index = groupJump(items, index, delta); render(); save(); void selectCurrent(); }
  async function followSelected() {
    clearTimeout(timer);
    if (!follow || !visible || typeof eagle?.item?.getSelected !== 'function') return;
    try {
      const selected = await eagle.item.getSelected();
      const id = selected?.[0]?.id || selected?.[0];
      const position = items.findIndex(row => row.itemIds?.includes(id) || row.primaryItemId === id);
      if (position >= 0 && position !== index) { index = position; render(); save(); }
    } catch { /* older Eagle builds */ }
    if (follow && visible) timer = setTimeout(followSelected, 700);
  }
  function key(event) {
    if (!visible || event.type !== 'keydown' || event.metaKey || event.ctrlKey || event.altKey) return false;
    const field = event.target?.closest?.('input, textarea, select');
    if (field && !field.matches('[type=checkbox]')) return false;
    const action = KEY_ACTIONS[event.key.toLowerCase()];
    if (action) { void decide(action); return true; }
    const moves = { ArrowRight: () => move(1), ArrowLeft: () => move(-1), ArrowDown: () => jumpGroup(1), ArrowUp: () => jumpGroup(-1) };
    if (moves[event.key]) { moves[event.key](); return true; }
    return false;
  }
  const hiddenByRemote = [];
  async function open(id) {
    runId = id; visible = true;
    for (const section of root.querySelectorAll('#start, #review, #cull')) {
      if (!section.hidden) { section.hidden = true; hiddenByRemote.push(section); }
    }
    el('remote').hidden = false;
    await load();
    void followSelected();
  }
  function close({ restore = true } = {}) {
    visible = false; clearTimeout(timer); el('remote').hidden = true; token++;
    for (const section of hiddenByRemote.splice(0)) if (restore) section.hidden = false;
  }
  function on(id, type, handler) { el(id)?.addEventListener(type, handler); }
  for (const [id] of MODES) on(`remoteMode-${id}`, 'click', () => setMode(id));
  for (const button of root.querySelectorAll('#remote [data-remote-decide]')) {
    button.addEventListener('click', () => void decide(button.dataset.remoteDecide));
  }
  on('remotePrevious', 'click', () => move(-1)); on('remoteNext', 'click', () => move(1));
  on('remoteNextGroup', 'click', () => jumpGroup(1));
  on('remoteExit', 'click', () => onExit());
  on('remoteReview', 'click', () => onOpenFocusedReview(runId));
  on('remoteFinish', 'click', () => onFinish(runId));
  on('remoteFollow', 'change', event => { follow = event.target.checked; if (follow) void followSelected(); else clearTimeout(timer); });
  on('remoteAdvance', 'change', event => { autoAdvance = event.target.checked; storage?.setItem(ADVANCE_KEY, autoAdvance ? '1' : '0'); });
  on('remoteTags', 'change', async event => {
    const enabled = event.target.checked;
    status(enabled ? '正在给 Eagle 加 AI 建议标签…' : '正在撤回本任务的标签…');
    try {
      await api(`/runs/${runId}/eagle-tags`, json({ enabled }));
      if (enabled && storage?.getItem(LIVE_KEYS.folders) !== '0') {
        void ensureSmartFolders(eagle, storage, () => {}, { force: true, includeProblemFolders: true });
      }
      status(enabled ? '已在 Eagle 中显示 AI 建议标签，可按标签筛选。' : '已撤回本任务的标签。');
    } catch (error) { event.target.checked = !enabled; status(`标签没有更新：${error.message}`, 'error'); }
  });
  on('remoteClearTags', 'click', async () => {
    try {
      const libraryPath = eagle?.library?.path || '';
      const dry = await api('/eagle/clear-ai-tags', json({ libraryPath, dryRun: true }));
      if (!dry.changed) { status('这个资源库里没有插件写入的 AI 标签。'); return; }
      if (!confirmImpl(`将从 ${dry.changed} 个项目上移除插件写入的 AI 标签（你自己的标签不受影响），继续吗？`)) return;
      const done = await api('/eagle/clear-ai-tags', json({ libraryPath, dryRun: false }));
      el('remoteTags').checked = false;
      status(`已清除 ${done.changed || 0} 个项目的 AI 标签${done.failed ? `，${done.failed} 个失败` : ''}。`, done.failed ? 'warn' : '');
    } catch (error) { status(`清除失败：${error.message}`, 'error'); }
  });
  return { open, close, load, decide, move, key, isVisible: () => visible,
    state: () => ({ runId, items, rows, index, mode, follow, autoAdvance }) };
}

export { ACTIONS, MODES };
