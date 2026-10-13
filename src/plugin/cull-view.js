import { ACTION_LABELS, FILTERS, FLAG_LABELS, KEY_ACTIONS, METHODS, PASSES, applyDecisionLocally, defaultTarget,
  effectiveAction, filterCounts, groupJump, matchesFilter, nextUndecided, passRows, progress, rangeSelect,
  targetPlan } from './cull-model.js';
import { ADJUSTMENT_LABELS, ADJUSTMENT_RANGES, DEFAULT_ADJUSTMENTS, adjustmentFilterMarkup, adjustmentsAreIdentity,
  autoExposure, lumaSamples, normalizeAdjustments } from './adjust.js';
import { restore as restoreSession, save as saveSession } from './review-session.js';
import { createZoomStage } from './zoom-stage.js';

const ADVANCE_KEY = 'eagle-culling-cull-advance';
const GRID_PAGE = 120;
const FILTER_ID = 'ec-cull-adjust';
const STRIP_SPAN = 60;
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function createCullView({ root = document, api, storage = globalThis.localStorage, imageUrl, thumbUrl,
  onExit = () => {}, onFinish = () => {}, onCompare = () => {}, onEagle = () => {}, onZoom = () => {}, confirmImpl = msg => confirm(msg),
  windowSizer = null } = {}) {
  const section = root.querySelector('#cull');
  const $ = selector => section.querySelector(selector);
  const state = { runId: null, title: '', rows: [], list: [], method: 'loupe', filter: 'all', pass: 'rejects', index: 0,
    selected: new Set(), anchor: null, page: 0, target: 0, adjustments: {}, adjustOpen: false, compare: false,
    autoAdvance: storage?.getItem(ADVANCE_KEY) !== '0', visible: false, busy: false };
  let saveTimer = null, loadToken = 0;

  const row = () => state.list[state.index] || null;
  const byId = id => state.rows.find(item => item.unitId === id);
  const status = (text, tone = '') => { const el = $('[data-cull-status]'); el.textContent = text; el.dataset.tone = tone; };
  const image = id => imageUrl?.(state.runId, id) || `${api.base || ''}/runs/${state.runId}/detail/${encodeURIComponent(id)}`;
  const thumb = id => thumbUrl?.(state.runId, id) || `${api.base || ''}/runs/${state.runId}/preview/${encodeURIComponent(id)}`;
  const runPath = (kind, id) => `${api.base || ''}/runs/${state.runId}/${kind}/${encodeURIComponent(id)}`;
  const stageElement = $('[data-cull-stage]');
  $('[data-cull-image]').crossOrigin = 'anonymous';
  const zoom = createZoomStage({ stage: stageElement, image: $('[data-cull-image]'), native: $('[data-cull-native]'),
    zoomLabel: $('[data-cull-zoom]'), nativeLabel: $('[data-cull-native-state]'), fitText: '适应',
    displayUrl: (id, edge) => `${runPath('display', id)}?edge=${edge}`,
    nativeUrl: (id, box, display) => `${runPath('native', id)}?box=${box.map(v => v.toFixed(5)).join(',')}`
      + `&width=${display.width}&height=${display.height}`,
    active: () => state.visible && showsLoupe() });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => zoom.refit()).observe(stageElement);
  else globalThis.addEventListener?.('resize', () => zoom.refit());

  function persist() {
    saveSession(state.runId, { method: state.method, filter: state.filter, pass: state.pass, target: state.target,
      unitId: row()?.unitId || null }, storage);
  }

  function rebuildList({ keep = row()?.unitId } = {}) {
    if (state.method === 'passes') state.list = state.pass === 'compare' ? [] : passRows(state.rows, state.pass);
    else if (state.method === 'target') state.list = targetPlan(state.rows, state.target).review;
    else state.list = state.rows.filter(item => matchesFilter(item, state.filter));
    const found = state.list.findIndex(item => item.unitId === keep);
    state.index = found >= 0 ? found : Math.max(0, Math.min(state.index, state.list.length - 1));
    state.selected = new Set([...state.selected].filter(id => state.list.some(item => item.unitId === id)));
    state.page = Math.floor(state.index / GRID_PAGE);
  }

  const showsGrid = () => state.method === 'grid' || state.method === 'target'
    || (state.method === 'passes' && state.pass === 'rejects');
  const showsLoupe = () => state.method === 'loupe' || (state.method === 'passes' && state.pass === 'picks');

  function renderBar() {
    const p = progress(state.rows);
    $('[data-cull-title]').textContent = state.title || '挑片';
    $('[data-cull-progress]').textContent = `已决定 ${p.decided} / ${p.total} · 精选 ${p.selected} · 淘汰 ${p.rejected}`;
    $('[data-cull-meter]').style.setProperty('--done', p.total ? `${(p.decided / p.total) * 100}%` : '0%');
    for (const button of section.querySelectorAll('[data-method]')) {
      button.setAttribute('aria-pressed', String(button.dataset.method === state.method));
    }
    const counts = filterCounts(state.rows);
    const filters = $('[data-cull-filters]');
    filters.hidden = state.method === 'passes' || state.method === 'target';
    filters.replaceChildren(...FILTERS.map(([id, label]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'chip'; button.dataset.filter = id;
      button.setAttribute('aria-pressed', String(id === state.filter));
      button.textContent = `${label} ${counts[id]}`;
      return button;
    }));
    const passes = $('[data-cull-passes]');
    passes.hidden = state.method !== 'passes';
    passes.replaceChildren(...PASSES.map(pass => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'pass-step'; button.dataset.pass = pass.id;
      button.setAttribute('aria-pressed', String(pass.id === state.pass));
      const count = pass.id === 'compare' ? new Set(passRows(state.rows, 'compare').map(item => item.groupId)).size
        : passRows(state.rows, pass.id).length;
      button.innerHTML = `<strong></strong><span></span>`;
      button.querySelector('strong').textContent = pass.label;
      button.querySelector('span').textContent = `${count} ${pass.id === 'compare' ? '组' : '张'} · ${pass.hint}`;
      return button;
    }));
  }

  function renderTarget() {
    const panel = $('[data-cull-target]');
    panel.hidden = state.method !== 'target';
    if (panel.hidden) return;
    const plan = targetPlan(state.rows, state.target);
    $('[data-target-input]').value = String(state.target);
    $('[data-target-input]').max = String(state.rows.length);
    $('[data-target-summary]').textContent = `按每组最佳优先、再按分数，保留前 ${plan.keep} 张。下面只列出保留线附近、`
      + `有问题或没把握的 ${plan.review.length} 张，请逐一确认。`;
    const accept = $('[data-target-accept]');
    const keepRest = plan.rest.filter(item => item.action === 'selected').length;
    accept.textContent = `其余 ${plan.rest.length} 张按 AI 结果确认（精选 ${keepRest}，淘汰 ${plan.rest.length - keepRest}）`;
    accept.disabled = !plan.rest.length || state.busy;
  }

  function badge(item) {
    const human = item.human ? ACTION_LABELS[item.human] : '';
    const ai = ACTION_LABELS[item.suggested] || '候选';
    return { text: human || `AI ${ai}`, kind: item.human || `ai-${item.suggested || 'candidate'}` };
  }

  function renderGrid() {
    const grid = $('[data-cull-grid]');
    grid.hidden = !showsGrid();
    $('[data-cull-pager]').hidden = grid.hidden || state.list.length <= GRID_PAGE;
    if (grid.hidden) return;
    const plan = state.method === 'target' ? targetPlan(state.rows, state.target) : null;
    const start = state.page * GRID_PAGE;
    const cards = state.list.slice(start, start + GRID_PAGE).map((item, offset) => {
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'cull-card'; card.dataset.unit = item.unitId;
      card.classList.toggle('focused', start + offset === state.index);
      card.classList.toggle('picked', state.selected.has(item.unitId));
      card.dataset.decision = effectiveAction(item); card.dataset.human = item.human ? '1' : '0';
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = item.fileName || ''; img.src = thumb(item.unitId);
      const tag = document.createElement('span');
      const b = badge(item); tag.className = `cull-badge ${b.kind}`; tag.textContent = b.text;
      const meta = document.createElement('span');
      meta.className = 'cull-meta';
      const flags = (item.flags || []).map(flag => FLAG_LABELS[flag]).filter(Boolean);
      const line = plan ? (plan.keepIds.has(item.unitId) ? '保留线内' : '保留线外') : `组 ${item.groupIndex + 1} · 第 ${item.rank}`;
      meta.textContent = [line, ...flags].join(' · ');
      card.append(img, tag, meta);
      return card;
    });
    grid.replaceChildren(...cards);
    if (!cards.length) grid.append(Object.assign(document.createElement('p'), { className: 'cull-empty',
      textContent: '这里没有需要处理的照片。' }));
    const pages = Math.max(1, Math.ceil(state.list.length / GRID_PAGE));
    $('[data-pager-label]').textContent = `第 ${state.page + 1} / ${pages} 页`;
    section.querySelector('.cull-card.focused')?.scrollIntoView?.({ block: 'nearest' });
  }

  function renderLoupe() {
    const loupe = $('[data-cull-loupe]');
    loupe.hidden = !showsLoupe();
    if (loupe.hidden) return;
    const item = row();
    if (!item) { zoom.clear(); $('[data-cull-info]').textContent = '这里没有需要处理的照片。'; return; }
    if (zoom.show(item.unitId, image(item.unitId))) $('[data-cull-image]').alt = item.fileName || '照片';
    const b = badge(item);
    const flags = (item.flags || []).map(flag => FLAG_LABELS[flag]).filter(Boolean);
    $('[data-cull-decision]').className = `cull-badge large ${b.kind}`;
    $('[data-cull-decision]').textContent = b.text;
    $('[data-cull-info]').textContent = [`${state.index + 1} / ${state.list.length}`, item.fileName,
      item.groupSize > 1 ? `本组 ${item.groupSize} 张中第 ${item.rank}` : '单张',
      item.human ? `AI 建议${ACTION_LABELS[item.suggested] || '候选'}` : '', ...flags, ...(item.reasons || []).slice(0, 2)]
      .filter(Boolean).join(' · ');
    const strip = $('[data-cull-strip]');
    const from = Math.max(0, state.index - STRIP_SPAN);
    strip.replaceChildren(...state.list.slice(from, state.index + STRIP_SPAN + 1).map((entry, offset) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.index = String(from + offset); button.dataset.decision = effectiveAction(entry);
      button.dataset.human = entry.human ? '1' : '0';
      button.classList.toggle('current', from + offset === state.index);
      const thumbImg = document.createElement('img');
      thumbImg.alt = ''; thumbImg.loading = 'lazy'; thumbImg.src = thumb(entry.unitId);
      button.append(thumbImg);
      return button;
    }));
    const current = strip.querySelector('.current');
    if (current) strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    for (const next of state.list.slice(state.index + 1, state.index + 3)) new Image().src = image(next.unitId);
    applyAdjustments();
  }

  function renderCompare() {
    const card = $('[data-cull-compare]');
    card.hidden = !(state.method === 'passes' && state.pass === 'compare');
    if (card.hidden) return;
    const groups = new Set(passRows(state.rows, 'compare').map(item => item.groupId)).size;
    $('[data-compare-text]').textContent = groups
      ? `${groups} 组连拍或相似照片。并排比较，每组选出最好的；没把握的组排在前面。`
      : '这次没有连拍或相似组，可以直接进入第 3 轮。';
    $('[data-compare-open]').disabled = !groups;
  }

  function renderActions() {
    const grid = showsGrid();
    const count = grid ? (state.selected.size || (row() ? 1 : 0)) : (row() ? 1 : 0);
    $('[data-cull-scope]').textContent = grid ? (state.selected.size ? `已选 ${state.selected.size} 张` : '当前照片') : '';
    for (const button of section.querySelectorAll('[data-decide]')) {
      button.disabled = !count || state.busy;
      button.classList.toggle('active', !grid && row()?.human === button.dataset.decide);
    }
    $('[data-cull-actions]').hidden = state.method === 'passes' && state.pass === 'compare';
    for (const el of section.querySelectorAll('[data-loupe-only]')) el.hidden = !showsLoupe();
    $('[data-cull-advance]').checked = state.autoAdvance;
  }

  function render() {
    if (!state.visible) return;
    section.dataset.method = state.method;
    renderBar(); renderTarget(); renderGrid(); renderLoupe(); renderCompare(); renderActions(); renderAdjustPanel();
    windowSizer?.render?.();
  }

  // ---- adjustments (view-only) ----
  const currentAdjustments = () => ({ ...DEFAULT_ADJUSTMENTS, ...(state.adjustments[row()?.unitId] || {}) });
  function filterFor(id) {
    const value = state.adjustments[id];
    return value && !adjustmentsAreIdentity(value) && !state.compare ? `url(#${FILTER_ID})` : 'none';
  }
  function applyAdjustments() {
    const item = row();
    $('[data-cull-filter]').innerHTML = adjustmentFilterMarkup(item ? state.adjustments[item.unitId] : {}, FILTER_ID);
    zoom.applyAdjustment(item ? filterFor(item.unitId) : 'none');
  }
  function renderAdjustPanel() {
    const panel = $('[data-cull-adjust]');
    panel.hidden = !(state.adjustOpen && showsLoupe());
    if (panel.hidden) return;
    const value = currentAdjustments();
    for (const input of panel.querySelectorAll('input[data-adjust]')) {
      input.value = String(value[input.dataset.adjust]);
      input.closest('label').querySelector('output').textContent = Number(input.value).toFixed(2);
    }
  }
  function storeAdjustments(ids, value) {
    const normal = normalizeAdjustments(value);
    for (const id of ids) { if (Object.keys(normal).length) state.adjustments[id] = normal; else delete state.adjustments[id]; }
    applyAdjustments(); renderAdjustPanel();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Promise.all(ids.map(id => api(`/runs/${state.runId}/adjustments/${encodeURIComponent(id)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(normal) })))
      .catch(error => status(`调整没有保存：${error.message}`, 'error')), 350);
  }
  function autoAdjust() {
    const img = $('[data-cull-image]');
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 192 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const exposure = autoExposure(lumaSamples(context, canvas.width, canvas.height));
      storeAdjustments([row().unitId], { ...currentAdjustments(), exposure });
    } catch { status('这张图暂时无法自动测光，请手动调整。', 'error'); }
  }

  // ---- decisions ----
  async function decide(action, ids = null) {
    const targets = ids || (showsGrid() && state.selected.size ? [...state.selected] : [row()?.unitId]).filter(Boolean);
    if (!targets.length || state.busy) return;
    const before = targets.map(id => [id, byId(id)?.human ?? null]);
    for (const id of targets) applyDecisionLocally(byId(id), action);
    const wasIndex = state.index;
    if (state.autoAdvance && !showsGrid() && targets.length === 1) state.index = Math.min(state.list.length - 1, state.index + 1);
    if (showsGrid() && state.selected.size) state.selected.clear();
    render(); persist();
    try {
      const result = await api(`/runs/${state.runId}/decisions`, json({ decisions: targets.map(unitId => action === 'clear'
        ? { unitId, clear: true } : { unitId, action }) }));
      status(result?.tagWarning ? `已保存；Eagle 标签没更新：${result.tagWarning}` : `已标记 ${targets.length} 张为${ACTION_LABELS[action] || 'AI 建议'}`,
        result?.tagWarning ? 'warn' : '');
    } catch (error) {
      for (const [id, human] of before) applyDecisionLocally(byId(id), human || 'clear');
      state.index = wasIndex; render();
      status(`没有保存：${error.message}`, 'error');
    }
  }

  async function acceptRest() {
    const plan = targetPlan(state.rows, state.target);
    if (!plan.rest.length) return;
    const keep = plan.rest.filter(item => item.action === 'selected').length;
    if (!confirmImpl(`把其余 ${plan.rest.length} 张按 AI 结果确认：精选 ${keep} 张、淘汰 ${plan.rest.length - keep} 张？`
      + '\n已手动决定的照片不受影响，之后仍可逐张改。')) return;
    state.busy = true; render();
    try {
      await api(`/runs/${state.runId}/decisions`, json({ decisions: plan.rest }));
      for (const item of plan.rest) applyDecisionLocally(byId(item.unitId), item.action);
      status(`已确认 ${plan.rest.length} 张`);
    } catch (error) { status(`没有保存：${error.message}`, 'error'); }
    finally { state.busy = false; render(); }
  }

  // ---- navigation ----
  function go(index) {
    if (!state.list.length) return;
    state.index = Math.max(0, Math.min(state.list.length - 1, index));
    state.page = Math.floor(state.index / GRID_PAGE);
    render(); persist();
  }
  function gridColumns() {
    const cards = section.querySelectorAll('.cull-card');
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    const index = [...cards].findIndex(card => card.offsetTop !== top);
    return index < 0 ? cards.length : index;
  }
  function setMethod(method) {
    if (!METHODS.some(([id]) => id === method)) return;
    state.method = method;
    if (method === 'target' && !state.target) state.target = defaultTarget(state.rows);
    rebuildList(); render(); persist();
  }
  function toggleCard(id, event) {
    if (event.shiftKey && state.anchor) for (const unit of rangeSelect(state.list, state.anchor, id)) state.selected.add(unit);
    else if (event.metaKey || event.ctrlKey) {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      state.anchor = id;
    } else { state.selected = new Set(); state.anchor = id; }
    state.index = state.list.findIndex(item => item.unitId === id);
    render(); persist();
  }

  function openFull() {
    const item = row();
    if (!item) return;
    onZoom(state.runId, item.unitId, { src: image(item.unitId), filter: filterFor(item.unitId),
      caption: `${state.index + 1} / ${state.list.length} · ${item.fileName || ''}` });
  }

  section.addEventListener('click', event => {
    const target = event.target.closest('button, [data-index]');
    if (!target || !section.contains(target)) return;
    const data = target.dataset;
    if (data.method) setMethod(data.method);
    else if (data.filter) { state.filter = data.filter; rebuildList(); render(); persist(); }
    else if (data.pass) { state.pass = data.pass; rebuildList(); render(); persist(); }
    else if (data.decide) void decide(data.decide);
    else if (data.unit) {
      if (event.detail > 1) { state.index = state.list.findIndex(item => item.unitId === data.unit); setMethod('loupe'); }
      else toggleCard(data.unit, event);
    }
    else if (data.index) go(Number(data.index));
    else if (data.cull === 'exit') onExit();
    else if (data.cull === 'finish') onFinish(state.runId);
    else if (data.cull === 'eagle') { close(); onEagle(state.runId); }
    else if (data.cull === 'prev') go(state.index - 1);
    else if (data.cull === 'next') go(state.index + 1);
    else if (data.cull === 'full') openFull();
    else if (data.cull === 'zoom-in') zoom.zoom(1.25);
    else if (data.cull === 'zoom-out') zoom.zoom(0.8);
    else if (data.cull === 'zoom-fit') zoom.toggle();
    else if (data.cull === 'adjust') { state.adjustOpen = !state.adjustOpen; render(); }
    else if (data.cull === 'auto') autoAdjust();
    else if (data.cull === 'reset') storeAdjustments([row().unitId], {});
    else if (data.cull === 'group') {
      const item = row();
      storeAdjustments(state.rows.filter(entry => entry.groupId === item.groupId).map(entry => entry.unitId), currentAdjustments());
      status('已把当前调整用到本组所有照片（只影响查看）');
    }
    else if (data.cull === 'page-prev') { state.page = Math.max(0, state.page - 1); renderGrid(); }
    else if (data.cull === 'page-next') {
      state.page = Math.min(Math.ceil(state.list.length / GRID_PAGE) - 1, state.page + 1); renderGrid();
    }
    else if (data.cull === 'accept') void acceptRest();
    else if (data.cull === 'compare') onCompare(state.runId);
  });
  $('[data-cull-strip]').addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY;
  }, { passive: false });
  section.addEventListener('input', event => {
    const name = event.target.dataset.adjust;
    if (name && row()) storeAdjustments([row().unitId], { ...currentAdjustments(), [name]: Number(event.target.value) });
    if (event.target.matches('[data-target-input]')) {
      state.target = Math.max(0, Math.min(state.rows.length, Math.round(Number(event.target.value) || 0)));
      rebuildList(); renderTarget(); renderGrid(); renderActions(); persist();
    }
  });
  section.addEventListener('change', event => {
    if (event.target.matches('[data-cull-advance]')) {
      state.autoAdvance = event.target.checked;
      storage?.setItem(ADVANCE_KEY, state.autoAdvance ? '1' : '0');
    }
  });

  function key(event) {
    if (!state.visible) return false;
    const field = event.target.closest?.('input, textarea, select');
    if (field && !(field.matches('[type=range], [type=checkbox]') && !event.key.startsWith('Arrow'))) return false;
    const lower = event.key.toLowerCase();
    if (event.key === '\\') { state.compare = event.type === 'keydown'; applyAdjustments(); return true; }
    if (event.type !== 'keydown') return false;
    const action = !event.metaKey && !event.ctrlKey && !event.altKey ? KEY_ACTIONS[lower] : null;
    if (action) { void decide(action); return true; }
    const grid = showsGrid();
    if ((event.metaKey || event.ctrlKey) && lower === 'a' && grid) {
      const start = state.page * GRID_PAGE;
      state.selected = new Set(state.list.slice(start, start + GRID_PAGE).map(item => item.unitId)); render(); return true;
    }
    if (event.key === 'ArrowRight') { go(state.index + 1); return true; }
    if (event.key === 'ArrowLeft') { go(state.index - 1); return true; }
    if (event.key === 'ArrowDown') { go(grid ? state.index + gridColumns() : groupJump(state.list, state.index, 1)); return true; }
    if (event.key === 'ArrowUp') { go(grid ? state.index - gridColumns() : groupJump(state.list, state.index, -1)); return true; }
    if (lower === 'n') { const next = nextUndecided(state.list, state.index); if (next >= 0) go(next); return true; }
    if (lower === 'g') { setMethod(state.method === 'grid' ? 'loupe' : 'grid'); return true; }
    if (event.key === 'Enter' && grid) { setMethod('loupe'); return true; }
    if (event.key === ' ' && !grid) { openFull(); return true; }
    if (showsLoupe() && !event.metaKey && !event.ctrlKey) {
      if (lower === 'z') { zoom.toggle(); return true; }
      if (event.key === '+' || event.key === '=') { zoom.zoom(1.25); return true; }
      if (event.key === '-' || event.key === '_') { zoom.zoom(0.8); return true; }
    }
    if (event.key === ' ' && grid) { setMethod('loupe'); return true; }
    if (lower === 'a' && showsLoupe()) { state.adjustOpen = !state.adjustOpen; render(); return true; }
    if (event.key === 'Escape') {
      if (state.adjustOpen) { state.adjustOpen = false; render(); return true; }
      if (showsLoupe() && zoom.isZoomed()) { zoom.fit(); return true; }
      if (state.selected.size) { state.selected.clear(); render(); return true; }
    }
    return false;
  }

  async function open(runId, { method } = {}) {
    const token = ++loadToken;
    state.runId = runId; state.visible = true; section.hidden = false;
    status('正在读取…');
    try {
      const [queue, run, adjustments] = await Promise.all([api(`/runs/${runId}/queue?mode=all`),
        api(`/runs/${runId}`).catch(() => ({})), api(`/runs/${runId}/adjustments`).catch(() => ({}))]);
      if (token !== loadToken) return;
      state.rows = queue.queue || queue.items || [];
      state.title = run?.scope?.label || run?.taskName || '挑片';
      state.adjustments = adjustments && typeof adjustments === 'object' ? adjustments : {};
      const session = restoreSession(runId, storage) || {};
      state.method = method || session.method || 'loupe';
      state.filter = FILTERS.some(([id]) => id === session.filter) ? session.filter : 'all';
      state.pass = PASSES.some(pass => pass.id === session.pass) ? session.pass : 'rejects';
      state.target = Number(session.target) || defaultTarget(state.rows);
      state.selected = new Set();
      rebuildList({ keep: session.unitId });
      if (!session.unitId && state.list.length && state.list[state.index]?.human) {
        const next = nextUndecided(state.list, state.index - 1);
        if (next >= 0) state.index = next;
      }
      status(state.rows.length ? '' : '这个任务还没有可挑的照片。');
      render();
    } catch (error) {
      if (token === loadToken) status(`读取失败：${error.message}`, 'error');
    }
  }

  function close() {
    state.visible = false; section.hidden = true; zoom.clear(); persist();
  }

  async function refresh() { if (state.visible && state.runId) await open(state.runId, { method: state.method }); }

  return { open, close, refresh, key, decide, setMethod, isVisible: () => state.visible, state: () => state };
}
