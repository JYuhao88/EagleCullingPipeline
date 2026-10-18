import { initEagleTheme } from '../theme.js';
import { percentScore } from '../score.js';
import { STAR_ACTIONS, STAR_HEADER, applyEagleStars, createStarWatcher, starSyncEnabled }
  from '../star-sync.js';
import { FLAG_LABELS } from '../cull-model.js';
import { createCodeReload, fetchPluginStamp } from '../code-reload.js';
import { canSelectInEagle, showInEagle } from '../eagle-select.js';
import { groupTarget, neighbourGroups, patchRows, runGroups, runProgress, selectionSummary, unitItems }
  from './inspector-groups.js';
import { COLUMNS, FOLD_OVER, compareTable, contrastLines, differenceLine, keepTopDecisions, scoreBars, visibleRows }
  from './inspector-compare.js';
import { createLiveWriteback } from '../live-writeback.js';
import { createDetailView } from './inspector-detail.js';

const BADGES = { selected: '精', candidate: '候', rejected: '汰' };
const MARKS = { selected: '★5', candidate: '★3', rejected: '★1' };
export function observationLines(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => item && typeof item.text === 'string'
    && ['good', 'bad', 'neutral'].includes(item.tone)).slice(0, 4).map(item => ({ ...item,
    className: `contrast ${{ good: 'better', bad: 'worse', neutral: 'neutral' }[item.tone]}`,
    title: item.source === 'model' && Number.isFinite(item.confidence)
      ? `校准置信度 ${Math.round(item.confidence * 100)}%` : '' }));
}
// One line about the whole group: AI split, how many you decided, and whether the grouping needs a look.
export function groupSummary(result) {
  const members = result?.groupMembers || [];
  if (members.length < 2) return members.length ? '单张，无需对比' : '';
  const count = action => members.filter(row => row.suggested === action).length;
  const decided = members.filter(row => row.human).length;
  return [`第 ${(result.groupIndex ?? -1) + 1 || '—'} 组 · ${members.length} 张`,
    `AI 建议 精选 ${count('selected')} · 候选 ${count('candidate')} · 淘汰 ${count('rejected')}`,
    decided === members.length ? '已全部决定' : `已定 ${decided}/${members.length}`,
    result.groupConfidence === 'low' ? '分组没把握，建议确认' : ''].filter(Boolean).join(' · ');
}
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
const PERSONALIZE_NAMES = { ...Object.fromEntries(COLUMNS.map(column => [column.key, column.name])), eyes: '睁眼比例' };
export function personalizationModel(report, { armed = false, busy = false, error = '' } = {}) {
  const rate = value => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  const learned = report ? `按你的 ${report.labeledGroups ?? 0} 个选优决定学习` : '正在读取学习情况…';
  const accuracy = report?.before && report?.after
    ? `；留出一致率 ${rate(report.after.top1?.rate)}，默认 ${rate(report.before.top1?.rate)}` : '';
  const factors = Object.entries(report?.weights || {}).filter(([key, value]) => PERSONALIZE_NAMES[key] && Number.isFinite(value))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
    .map(([key, value]) => `${PERSONALIZE_NAMES[key]}（${value < 0 ? '负向' : '正向'}）`).join('、');
  const hint = !report || report.ready ? '' : report.reason === 'insufficient-data'
    ? '请继续挑选各组最喜欢的一张，需要更多有时间记录、内容独立的训练和留出样本'
    : '留出一致率尚未稳定优于默认建议，请继续挑选以积累偏好';
  return { summary: learned + accuracy, factors: factors ? `最影响的因素：${factors}` : '', hint, error,
    applied: report?.applied ? `已调整 ${report.applied.changedGroups} 组` : '',
    button: busy ? '处理中…' : armed ? '确认应用' : `应用到剩余 ${report?.remainingGroups ?? 0} 组`,
    disabled: busy || !report?.ready || !report?.remainingGroups, undoDisabled: busy };
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
const MULTI_LIMIT = 300;
const ACTION_NAMES = { selected: '精选', candidate: '候选', rejected: '淘汰' };
// Eagle reloads this page whenever the first selected photo changes, so anything that should survive a photo switch
// (run queue, last group analysis, page height, a pending note) lives in localStorage: Eagle builds a fresh page each
// time, so sessionStorage does not carry over.
const SESSION = { queue: 'eagle-culling-inspector-queue', group: 'eagle-culling-inspector-group',
  height: 'eagle-culling-inspector-height', note: 'eagle-culling-inspector-note', expanded: 'eagle-culling-table-expanded',
  keep: 'eagle-culling-inspector-keep', personalize: 'eagle-culling-inspector-personalize' };
const QUEUE_FIELDS = ['unitId', 'primaryItemId', 'itemIds', 'groupId', 'groupIndex', 'rank', 'suggested', 'human',
  'confidence', 'flags', 'unitFlags'];
const QUEUE_TTL = 60000;
// Eagle looks up the existing webview with `$('#inspector-plugin-' + id)`; dots in the id would read as classes, so
// the lookup fails and Eagle rebuilds the webview (white, collapsed, panel scrolled up) on every selection change.
const PLUGIN_ID = 'eagle-culling', LEGACY_PLUGIN_ID = 'com.eagle.culling';
const EAGLE_ORDER_KEY = 'eagle.inspector.itemsOrder';
const PLACEMENT_KEY = 'eagle-culling-inspector-placement', PLACEMENT = 'top-2';
// Eagle's own window shares this file:// localStorage and reads the section order only at startup. The section is
// moved above 标签 once; after that a dragged order is left alone.
export function placeInspectorFirst(storage) {
  const placed = storage.getItem(PLACEMENT_KEY);
  if (placed === PLACEMENT) return false;
  let order;
  try { order = JSON.parse(storage.getItem(EAGLE_ORDER_KEY) || 'null'); } catch { order = null; }
  if (!order || typeof order !== 'object') order = { tags: 0, folders: 1, annotations: 2, information: 100 };
  const legacy = order[LEGACY_PLUGIN_ID];
  delete order[LEGACY_PLUGIN_ID];
  const others = Object.entries(order).filter(([id, value]) => id !== PLUGIN_ID && Number.isFinite(value));
  order[PLUGIN_ID] = placed === 'top-1' && Number.isFinite(legacy) ? legacy
    : Math.min(0, ...others.map(([, value]) => value)) - 1;
  storage.setItem(EAGLE_ORDER_KEY, JSON.stringify(order));
  storage.setItem(PLACEMENT_KEY, PLACEMENT);
  return true;
}
const MARKS_KEY = 'eagle-culling-marks';
const TRACE_KEY = 'eagle-culling-inspector-trace';
// A short local log of page loads, renders and errors: Eagle offers no console for inspector pages.
export function trace(event, storage = globalThis.localStorage) {
  try {
    const fs = globalThis.require?.('fs'), os = globalThis.require?.('os');
    if (fs && os) fs.appendFileSync(`${os.tmpdir()}/eagle-culling-inspector-trace.log`,
      `${new Date().toISOString().slice(11, 23)} ${String(event).slice(0, 300)}\n`);
  } catch { /* not inside Eagle */ }
  try {
    const list = JSON.parse(storage.getItem(TRACE_KEY) || '[]').slice(-29);
    list.push([new Date().toISOString().slice(11, 23), String(event).slice(0, 300)]);
    storage.setItem(TRACE_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener?.('error', event => trace(`error ${event.message} @${event.filename}:${event.lineno}`));
  window.addEventListener?.('unhandledrejection', event => trace(`rejection ${String(event.reason?.stack || event.reason)
    .slice(0, 60)} ${new Error().stack?.split('\n').slice(1, 4).join(' ')}`));
}
const SNAPSHOT_KEY = 'eagle-culling-inspector-snapshot';
const STILLS_KEY = 'eagle-culling-inspector-stills', STILL_EDGE = 360;
const SVG = 'http://www.w3.org/2000/svg';
const BODY_LINES = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14],
  [14, 16], [0, 1], [0, 2], [1, 3], [2, 4]];
export function mountInspector({ root = document, eagle = globalThis.eagle, storage = localStorage, fetchImpl = fetch,
  now = Date.now, session = globalThis.localStorage, pageUrl = globalThis.location?.href } = {}) {
  trace(`mount ${String(pageUrl || '').split('?id=')[1]?.slice(0, 13) || ''} eagle=${Boolean(eagle?.item)} `
    + `early=${globalThis.__earlyTrace || ''}`, storage);
  if (globalThis.innerHeight !== undefined && root.body) {
    let last = '';
    const started = now();
    const sample = () => {
      const line = `h view=${globalThis.innerHeight} body=${root.body.scrollHeight} focus=${root.hasFocus?.()}`;
      if (line !== last) { last = line; trace(line, storage); }
      if (now() - started < 1500) setTimeout(sample, 50);
    };
    sample();
    globalThis.addEventListener?.('focus', () => trace('window focus', storage));
    globalThis.addEventListener?.('blur', () => trace('window blur', storage));
  }
  void initEagleTheme({ eagle, doc: root });
  try { placeInspectorFirst(storage); } catch {}
  let version = 0, timer, visible = !root.hidden, disposed = false, lastKey = '', lastFetch = 0;
  let current = { state: 'empty', result: null, selected: [] };
  // The run queue is cached per run; the selected photo's analysis keeps its own group fresh in between.
  let queue = { runId: null, rows: [], at: 0 }, queueLoad = null;
  // The server keeps one undo stack per run; 撤销 pops only the operations made from this panel.
  let saving = 0, regroupUndo = 0, armed = null;
  let personal = { runId: null, report: null, at: -Infinity }, personalLoad = null, personalBusy = false;
  let aiTagsArmed = null, aiTagsTimer, aiTagsBusy = false, aiTagsStatus = '';
  let personalArmed = null, personalTimer, personalError = '', personalRevision = 0;
  const el = id => root.querySelector(`#${id}`);
  const baseUrl = () => (storage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125').replace(/\/$/, '');
  const runRows = () => queue.runId && queue.runId === current.result?.runId ? queue.rows : [];
  const detail = createDetailView({ root, storage, baseUrl });
  const selectedIds = (selected = current.selected) => selected.map(item => item?.id || item).filter(Boolean);
  const canSelect = () => canSelectInEagle(eagle);
  // A switch started from this panel is drawn at once; the snapshot it leaves covers the page Eagle builds next.
  // One photo selects only its primary file: a JPG+RAW pair would flip Eagle's preview to its taller multi-file
  // layout and shift the whole panel.
  const select = ids => {
    if (!ids?.length) return;
    const member = [...(current.result?.groupMembers || []), ...runRows()]
      .find(row => (row.itemIds || []).includes(ids[0]));
    const target = member && ids.every(id => member.itemIds.includes(id)) ? [member.primaryItemId || ids[0]] : ids;
    if (JSON.stringify(selectedIds()) === JSON.stringify(target)) return;
    if (current.state === 'result') renderMember(current.result, target[0], target);
    void showInEagle(eagle, target).then(() => refresh(true)).catch(() => {});
  };
  const previewUrl = (runId, unitId) => `${baseUrl()}/runs/${encodeURIComponent(runId)}/preview/${encodeURIComponent(unitId)}`;
  // Re-rendering reuses the decoded <img> nodes (also the ones restored from the snapshot) so thumbnails never blink.
  const pool = new Map();
  const observationFrames = new Map();
  let observationOverlays = [];
  let epoch = 0;
  // A reloaded page cannot paint URL images in its first frame, but a data: image with sync decoding is ready at once.
  // Every member of the shown group keeps such a still (preview URL -> data: URL) so any snapshot can carry them.
  let stills = new Map(), groupSources = [], stillsTimer;
  try { stills = new Map(Object.entries(JSON.parse(session?.getItem(STILLS_KEY) || '{}'))); } catch { /* none yet */ }
  const newImage = src => {
    const image = root.createElement('img'); image.decoding = 'sync'; image.alt = '';
    image.crossOrigin = 'anonymous'; image.dataset.pool = src;
    image.addEventListener?.('load', () => keepStill(image));
    image.src = src;
    return image;
  };
  for (const image of root.querySelectorAll?.('img[data-pool]') || []) {
    pool.set(image.dataset.pool, [image]);
    // Snapshot copies carry inline stills; the swap back keeps showing the still until the full preview has loaded.
    if (image.src?.startsWith('data:')) {
      if (!stills.has(image.dataset.pool)) stills.set(image.dataset.pool, image.src);
      image.crossOrigin = 'anonymous'; image.src = image.dataset.pool;
    }
  }
  function pooledImage(src) {
    const list = pool.get(src) || [];
    let image = list.find(node => node.dataset.epoch !== String(epoch));
    if (!image) { image = newImage(src); list.push(image); pool.set(src, list); }
    image.dataset.epoch = String(epoch);
    return image;
  }
  function keepStill(image) {
    const src = image.dataset?.pool;
    if (!src || stills.has(src) || !image.naturalWidth || image.src.startsWith('data:')) return;
    try {
      const scale = Math.min(1, STILL_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = root.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      stills.set(src, canvas.toDataURL('image/jpeg', 0.78));
    } catch { return; /* no canvas or a cross-origin image without CORS */ }
    clearTimeout(stillsTimer);
    stillsTimer = setTimeout(() => {
      const keep = new Set(groupSources);
      sessionSet(STILLS_KEY, Object.fromEntries([...stills].filter(([src]) => keep.has(src))));
    }, 200);
  }
  function stillOf(image) {
    if (!image) return null;
    if (image.complete && image.src?.startsWith('data:')) return image.src;
    if (image.complete) keepStill(image);
    return stills.get(image.dataset?.pool || image.src) || null;
  }
  // Load and decode every member's preview up front: picking any photo then redraws without a blank frame.
  function preloadGroup(result) {
    if (!result?.runId) return;
    groupSources = (result.groupMembers || []).slice(0, 80).map(member => previewUrl(result.runId, member.unitId));
    for (const src of groupSources) if (!pool.has(src)) pool.set(src, [newImage(src)]);
  }
  const marksOn = () => storage.getItem(MARKS_KEY) === '1';
  // An SVG with the image's own size as its viewBox and 'meet' scaling lands exactly on an object-fit: contain image.
  function drawMarks(box, image, marks) {
    if (!marksOn() || !marks || !root.createElementNS) return;
    const svg = root.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'marks'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const shape = (tag, attrs) => {
      const node = root.createElementNS(SVG, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      node.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(node);
    };
    const draw = () => {
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height) return;
      svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const rect = (b, cls) => shape('rect', { class: cls, x: b[0] * width, y: b[1] * height,
        width: (b[2] - b[0]) * width, height: (b[3] - b[1]) * height });
      for (const person of marks.persons || []) {
        rect(person.box, person.main ? 'person main' : 'person');
        const point = index => person.points?.[index]?.[2] >= 0.3 ? person.points[index] : null;
        for (const [a, b] of BODY_LINES) {
          const from = point(a), to = point(b);
          if (from && to) shape('line', { class: person.main ? 'bone main' : 'bone', x1: from[0] * width, y1: from[1] * height,
            x2: to[0] * width, y2: to[1] * height });
        }
      }
      for (const face of marks.faces || []) rect(face.box, face.closed ? 'face closed' : 'face');
    };
    if (image.complete && image.naturalWidth) draw(); else image.addEventListener?.('load', draw, { once: true });
    box.append(svg);
  }
  const starHeaders = () => ({ 'content-type': 'application/json',
    ...(starSyncEnabled(storage) ? { [STAR_HEADER]: '1' } : {}) });
  const sessionGet = key => { try { return JSON.parse(session?.getItem(key) || 'null'); } catch { return null; } };
  const sessionSet = (key, value) => { try { session?.setItem(key, JSON.stringify(value)); } catch { /* quota: skip */ } };
  // carry: the action also changes the Eagle selection, which reloads this page; show the note after the reload.
  function note(text, { carry = false } = {}) {
    const node = el('actionStatus'); if (node) node.textContent = text;
    if (carry) sessionSet(SESSION.note, { text, at: now() });
  }
  function saveQueue() {
    if (queue.runId) sessionSet(SESSION.queue, { runId: queue.runId, at: queue.at,
      rows: queue.rows.map(row => Object.fromEntries(QUEUE_FIELDS.filter(key => key in row).map(key => [key, row[key]]))) });
  }
  function patchQueue(unitId, human) {
    if (!queue.rows.some(row => row.unitId === unitId)) return;
    queue = { ...queue, rows: queue.rows.map(row => row.unitId === unitId ? { ...row, human, action: human || row.suggested } : row) };
    saveQueue();
  }
  // index.html holds the last height until the first real render, so Eagle's panel neither collapses nor loses its
  // scroll position while the new document loads.
  const body = root.body;
  function releaseHeight() {
    if (!body?.style) return;
    root.getElementById?.('earlyHold')?.remove?.();
    body.style.minHeight = '';
    try { session?.setItem(SESSION.height, String(body.scrollHeight || 0)); } catch { /* ignore */ }
  }
  // 「挑片时实时写回标签」 in the main window's settings shares this storage.
  const live = createLiveWriteback({ storage, onStatus: (text, failed) => { if (failed) note(text); },
    api: async (path, options) => {
      const response = await fetchImpl(`${baseUrl()}${path}`, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    } });

  // RAW+JPEG pairs are one photo: a selection only counts as multiple when it spans several photo units.
  function selectedUnits(selected = current.selected) {
    const ids = selectedIds(selected);
    const rows = runRows().length ? runRows() : (current.result?.groupMembers || []);
    const summary = selectionSummary(rows, ids);
    return { ...summary, count: summary.units.length + summary.unknown };
  }
  function render(state, result, selected = current.selected) {
    if (state !== current.state || result?.unitId !== current.result?.unitId) trace(`render ${state} ${result?.unitId || ''}`, storage);
    current = { state, result, selected }; epoch++;
    clearObservationBoxes(); observationFrames.clear();
    if (state === 'result') preloadGroup(result);
    const model = inspectorModel({ state, result });
    const units = state === 'result' ? selectedUnits(selected) : { count: selected.length, units: [], groupCount: 0 };
    const multi = units.count > 1 || state === 'many';
    const status = el('status');
    status.textContent = multi ? `已选 ${state === 'many' ? selected.length : units.count} 张` : model.badge;
    if (status.dataset) status.dataset.tone = multi ? '' : model.tone || '';
    const lines = el('lines'); lines.replaceChildren();
    const compared = state === 'result' && (result.groupMembers || []).length > 1;
    // The comparison table already shows rank, score and sharpness; keep only the task line then.
    if (!multi) for (const text of compared ? model.lines.slice(-1) : model.lines) {
      const row = root.createElement('p'); row.textContent = text; lines.append(row);
    }
    el('reasons').textContent = model.reasons.join('；');
    el('details').hidden = multi || !model.reasons.length;
    // The per-photo analysis only sees its own group, so its groupIndex is always 0; the run queue knows the real one.
    const groupIndex = runRows().find(row => row.groupId === result?.groupId)?.groupIndex ?? result?.groupIndex;
    const members = state === 'result' ? result.groupMembers || [] : [];
    const count = el('selectedCount');
    if (count) count.textContent = state === 'many' ? `超过 ${MULTI_LIMIT} 张时只统计数量`
      : multi ? [units.groupCount === 1 ? `都在第 ${(units.groupIndex ?? result?.groupIndex ?? 0) + 1} 组`
        : units.groupCount ? `跨 ${units.groupCount} 组` : '',
        units.unknown ? `${units.unknown} 张未分析` : ''].filter(Boolean).join(' · ')
        : members.length > 1 ? [`第 ${(groupIndex ?? 0) + 1} 组`,
          `已定 ${members.filter(member => member.human).length}/${members.length}`,
          result.groupConfidence === 'low' ? '分组没把握' : ''].filter(Boolean).join(' · ') : '';
    for (const button of root.querySelectorAll?.('[data-decision]') || []) {
      button.classList.toggle('active', !multi && model.currentAction === button.dataset.decision);
      button.disabled = state !== 'result';
    }
    const group = el('groupContext');
    if (group) group.textContent = state === 'result' ? groupSummary({ ...result, groupIndex }) : '';
    const difference = el('difference');
    if (difference) renderDifference(difference, compared && !multi ? result : null);
    const position = el('position');
    if (position) position.textContent = state === 'result' && !multi && result.groupSize > 1
      ? `第 ${result.rank ?? '—'} / ${result.groupSize} 名` : '';
    renderTable(compared ? result : null, selected);
    renderPair(compared && !multi ? result : null);
    renderObservations(state === 'result' && !multi ? result : null);
    renderChart(compared ? result : null, selected);
    renderKeep(compared && !multi ? result : null);
    if (compared && result.groupId) sessionSet(SESSION.group, { runId: result.runId, groupId: result.groupId, result });
    const undecided = members.filter(member => !member.human);
    for (const [id, enabled] of [['selectGroup', members.length > 1], ['selectUndecided', undecided.length > 0],
      ['acceptGroup', undecided.length > 0]]) { const button = el(id); if (button) button.disabled = !enabled; }
    for (const id of ['selectGroup', 'selectUndecided']) { const button = el(id); if (button) button.hidden = !canSelect(); }
    const accept = el('acceptGroup');
    if (accept) {
      accept.textContent = undecided.length ? `按 AI 建议 ${undecided.length}` : '已全部决定';
      accept.title = undecided.length ? `本组未决定的 ${undecided.length} 张按 AI 建议决定，已决定的不变` : '';
    }
    const aiTags = el('aiTags');
    if (aiTags) {
      const tags = state === 'result' && !multi ? (result.aiTags || []).map(row => row.tag) : [];
      const key = JSON.stringify(tags);
      if (aiTags.dataset?.tags !== key) {
        aiTags.replaceChildren(...tags.map(tag => {
          const node = root.createElement('span'); node.textContent = tag; return node;
        }));
        if (aiTags.dataset) aiTags.dataset.tags = key;
      }
      aiTags.hidden = !tags.length;
    }
    const tags = el('tagsState');
    if (tags) tags.textContent = model.tagsOn ? 'AI 标签已开启' : 'AI 标签未开启';
    const fallback = el('eagleFallback');
    if (fallback) fallback.hidden = canSelect();
    renderRun();
    syncPersonalization();
    renderMarksToggle(compared ? result : null);
    detail.render(state === 'result' && !multi ? result : null);
    if (state !== 'loading') { releaseHeight(); saveSnapshot(); }
  }
  function renderMarksToggle(result) {
    const toggle = el('marksToggle'); if (!toggle) return;
    const members = result?.groupMembers || [];
    toggle.hidden = !members.some(member => member.marks);
    const input = el('marksOn'); if (input) input.checked = marksOn();
    const hint = el('marksHint');
    if (hint) hint.textContent = marksOn() && !members.some(member => member.marks?.persons?.length)
      ? '这次分析没有姿态数据，只标人脸；重新分析后才有人体姿态' : '';
  }
  // Eagle reloads this page on every photo switch; index.html paints this copy before any script runs.
  function saveSnapshot() {
    const section = el('inspector') || root.querySelector?.('#inspector');
    const sig = root.documentElement?.dataset?.layout;
    if (current.state !== 'result' || !sig || typeof section?.innerHTML !== 'string') return;
    const ids = (current.result.groupMembers || []).flatMap(member => member.itemIds || []);
    let html = section.innerHTML;
    const copy = section.cloneNode?.(true);
    if (copy?.querySelectorAll) {
      const live = [...section.querySelectorAll('img')];
      [...copy.querySelectorAll('img')].forEach((image, index) => {
        const still = stillOf(live[index]); if (!still) return;
        image.src = still; image.decoding = 'sync'; image.removeAttribute('loading');
      });
      html = copy.innerHTML;
    }
    sessionSet(SNAPSHOT_KEY, { sig, at: now(), ids: ids.length ? ids : selectedIds(), html, height: body?.scrollHeight || 0 });
  }
  function renderPersonalization() {
    const box = el('personalize'); if (!box) return;
    const runId = current.state === 'result' ? current.result?.runId : null;
    box.hidden = !runId;
    const report = personal.runId === runId ? personal.report : null;
    const model = personalizationModel(report, { armed: personalArmed !== null, busy: personalBusy, error: personalError });
    for (const [id, text] of [['personalizeSummary', model.summary], ['personalizeFactors', model.factors],
      ['personalizeHint', model.hint], ['personalizeError', model.error],
      ['personalizeApplied', model.applied ? `${model.applied} ·` : '']]) {
      const node = el(id); if (node) { node.textContent = text; node.hidden = !text; }
    }
    const apply = el('personalizeApply');
    if (apply) { apply.textContent = model.button; apply.disabled = model.disabled; }
    const undo = el('personalizeUndo');
    if (undo) { undo.hidden = !report?.applied; undo.disabled = model.undoDisabled; }
    saveSnapshot();
  }
  function syncPersonalization() {
    const runId = current.state === 'result' ? current.result?.runId : null;
    if (personal.runId !== runId) {
      personalRevision++; clearTimeout(personalTimer); personalArmed = null; personalError = '';
      const cached = sessionGet(SESSION.personalize);
      personal = cached?.runId === runId ? cached : { runId, report: null, at: -Infinity };
    }
    renderPersonalization();
    if (runId && !personalBusy && now() - personal.at >= 15000) void loadPersonalization();
  }
  async function loadPersonalization(force = false) {
    const runId = personal.runId;
    if (!runId || (personalLoad?.runId === runId && !force)) return personalLoad?.promise;
    const revision = ++personalRevision;
    const promise = (async () => {
      try {
        const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/personalize`,
          { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('读取失败');
        const report = await response.json();
        if (disposed || revision !== personalRevision || personal.runId !== runId) return;
        personal = { runId, report, at: now() }; personalError = '';
        sessionSet(SESSION.personalize, personal); renderPersonalization();
      } catch {
        if (!disposed && revision === personalRevision) {
          personal.at = now(); personalError = '学习情况读取失败，请稍后重试'; renderPersonalization();
        }
      }
    })().finally(() => { if (personalLoad?.promise === promise) personalLoad = null; });
    personalLoad = { runId, promise }; return promise;
  }
  async function personalize(mode = 'apply') {
    const runId = current.result?.runId;
    if (current.state !== 'result' || personal.runId !== runId || personalBusy) return;
    if (mode === 'apply') {
      if (!personal.report?.ready || !personal.report.remainingGroups) return;
      if (personalArmed === null || now() - personalArmed >= 3000) {
        clearTimeout(personalTimer); personalArmed = now(); personalError = ''; renderPersonalization();
        personalTimer = setTimeout(() => {
          personalArmed = null; if (!disposed) renderPersonalization();
        }, 3000); personalTimer?.unref?.(); return;
      }
    } else if (mode !== 'undo' || !personal.report?.applied) return;
    clearTimeout(personalTimer); personalArmed = null; personalBusy = true; personalError = '';
    personalRevision++; saving++; renderPersonalization();
    try {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/personalize/${mode}`,
        { method: 'POST', signal: AbortSignal.timeout(15000) });
      if (disposed || personal.runId !== runId) return;
      if (!response.ok) {
        personalError = response.status === 409 ? '偏好尚未稳定优于默认建议，请继续挑选' : '操作失败，请稍后重试';
        return;
      }
      await loadPersonalization(true);
      await queueLoad?.promise;
      staleQueue(); lastKey = ''; lastFetch = 0;
      await loadQueue(runId); await refresh(true);
    } catch {
      if (personal.runId === runId) personalError = '操作未完成，请稍后刷新查看';
    } finally { personalBusy = false; saving--; if (!disposed) renderPersonalization(); }
  }
  function renderRun() {
    const rows = runRows(), result = current.state === 'result' ? current.result : null;
    const progress = runProgress(rows), groups = runGroups(rows);
    const line = el('runProgress');
    if (line) line.textContent = rows.length ? [result.runName, `已定 ${progress.decided}/${progress.total}`,
      `精选 ${progress.selected}`, `候选 ${progress.candidate}`, `淘汰 ${progress.rejected}`].filter(Boolean).join(' · ') : '';
    const finish = el('finishHint'); if (finish) finish.hidden = !progress.done;
    for (const button of root.querySelectorAll?.('[data-nav]') || [])
      button.disabled = !result || !groupTarget(groups, result.groupId, button.dataset.nav);
    const plan = result ? regroupPlan() : null;
    for (const button of root.querySelectorAll?.('[data-regroup]') || [])
      button.disabled = saving > 0 || (button.dataset.regroup === 'undo' ? !regroupUndo : !plan?.[button.dataset.regroup]);
    for (const button of root.querySelectorAll?.('[data-bulk]') || []) {
      const count = bulkDecisions(button.dataset.bulk).length;
      button.disabled = saving > 0 || !count;
      button.textContent = armed?.mode === button.dataset.bulk ? `再点一次：${count} 张` : `${BULK[button.dataset.bulk].label}（${count}）`;
    }
    renderAiTagActions();
    const box = el('neighbours'); if (!box) return;
    const neighbours = result ? neighbourGroups(groups, result.groupId) : [];
    box.hidden = !neighbours.length;
    box.replaceChildren(...neighbours.map(({ side, group: item }) => {
      const node = root.createElement('button');
      node.type = 'button'; node.className = 'neighbour'; node.dataset.side = side;
      const image = pooledImage(previewUrl(result.runId, item.best.unitId));
      const text = root.createElement('span');
      text.textContent = [`${side === 'prev' ? '前' : '后'}一组 · 第 ${item.groupIndex + 1} 组 · ${item.units.length} 张`,
        item.done ? '已全部决定' : `已定 ${item.decided}`, item.confidence === 'low' ? '没把握' : ''].filter(Boolean).join(' · ');
      node.append(image, text);
      node.addEventListener?.('click', () => select(unitItems(item.best)));
      return node;
    }));
  }
  function renderTable(result, selected) {
    const table = el('compareTable'); if (!table) return;
    const { columns, rows } = compareTable(result?.groupMembers || []);
    table.hidden = !rows.length;
    if (table.hidden) { table.replaceChildren(); return; }
    const chosen = new Set(selectedIds(selected));
    const cell = (tag, text, title = '') => {
      const node = root.createElement(tag); node.textContent = text; if (title) node.title = title; return node;
    };
    const head = root.createElement('tr');
    head.append(cell('th', ''), cell('th', '#', '组内名次 · AI 建议 · 你的决定'),
      ...columns.map(column => cell('th', column.label, column.title)));
    const expanded = sessionGet(SESSION.expanded) === result.groupId;
    const shown = visibleRows(rows, rows.findIndex(row => row.itemIds.some(id => chosen.has(id))), expanded);
    const more = el('expandTable');
    if (more) {
      more.hidden = rows.length === shown.length && !expanded;
      more.textContent = expanded ? '只看重点行' : `展开全部 ${rows.length} 张`;
    }
    table.replaceChildren(head, ...shown.map(({ row, gap }) => {
      if (gap) {
        const line = root.createElement('tr'); line.className = 'gap';
        const node = cell('td', `… 中间 ${gap} 张`); node.colSpan = columns.length + 2; line.append(node);
        line.addEventListener?.('click', () => toggleExpanded(result.groupId));
        return line;
      }
      const line = root.createElement('tr');
      line.dataset.suggested = row.suggested;
      if (row.itemIds.some(id => chosen.has(id))) line.classList.add('current');
      const flags = (row.flags || []).map(flag => FLAG_LABELS[flag]).filter(Boolean);
      line.title = [[row.name, `第 ${row.rank} 名`, `AI 建议${ACTION_NAMES[row.suggested]}`,
        row.human ? `你的决定：${MARKS[row.human]}` : '', ...flags].filter(Boolean).join(' · '),
      (row.reasons || []).join('，')].filter(Boolean).join('\n');
      const rank = cell('td', `${row.rank} ${BADGES[row.suggested] || '候'}${row.human ? ` ${MARKS[row.human]}` : ''}`);
      rank.className = 'rank';
      if (flags.length) rank.append(cell('span', ' !', flags.join('、')));
      const thumb = root.createElement('td'); thumb.className = 'thumb';
      const frame = root.createElement('div'); frame.className = 'frame';
      const image = pooledImage(previewUrl(result.runId, row.unitId));
      rememberObservationFrame(row.unitId, frame, image);
      frame.append(image); drawMarks(frame, image, row.marks); thumb.append(frame);
      line.append(thumb, rank, ...row.cells.map(item => {
        const node = cell('td', item.text); if (item.best) node.className = 'best'; return node;
      }));
      line.addEventListener?.('click', () => select(row.itemIds));
      return line;
    }));
  }
  function renderChart(result, selected) {
    const chart = el('groupChart'); if (!chart) return;
    const bars = result ? scoreBars(result.groupMembers) : [];
    chart.hidden = bars.length <= FOLD_OVER;
    if (chart.hidden) { chart.replaceChildren(); return; }
    const chosen = new Set(selectedIds(selected));
    chart.replaceChildren(...bars.map(bar => {
      const node = root.createElement('button');
      node.type = 'button'; node.className = 'bar'; node.dataset.action = bar.action;
      if (bar.decided) node.classList.add('decided');
      if (bar.itemIds.some(id => chosen.has(id))) node.classList.add('current');
      if (node.style) node.style.setProperty?.('--h', bar.height.toFixed(3));
      node.title = [`第 ${bar.rank} 名`, bar.score === null ? '' : `总分 ${Math.round(bar.score * 100)}`,
        `${bar.decided ? '你的决定' : 'AI 建议'}${ACTION_NAMES[bar.action] || ''}`].filter(Boolean).join(' · ');
      node.addEventListener?.('click', () => select(bar.itemIds));
      return node;
    }));
  }
  const keepCount = result => {
    const stored = sessionGet(SESSION.keep);
    const size = result.groupMembers.length;
    const fallback = Math.min(3, size - 1);
    return Math.max(1, Math.min(size - 1, stored?.groupId === result.groupId ? stored.count : fallback));
  };
  function renderKeep(result) {
    const box = el('keepTop'); if (!box) return;
    box.hidden = !result || result.groupMembers.length < 4;
    if (box.hidden) return;
    const count = keepCount(result), changes = keepTopDecisions(result.groupMembers, count);
    el('keepCount').textContent = String(count);
    const apply = el('keepApply');
    apply.disabled = saving > 0 || !changes.length;
    const rejects = changes.filter(row => row.action === 'rejected').length;
    apply.textContent = armed?.mode === 'keep' ? `再点一次：改 ${changes.length} 张` : `其余 ${rejects} 张淘汰`;
  }
  function stepKeep(delta) {
    const result = current.result; if (!result?.groupId) return;
    sessionSet(SESSION.keep, { groupId: result.groupId, count: keepCount(result) + delta });
    armed = null; renderKeep(result);
  }
  async function applyKeep() {
    const result = current.result; if (!result?.groupId) return;
    if (armed?.mode !== 'keep' || now() - armed.at > 4000) {
      armed = { mode: 'keep', at: now() }; renderKeep(result);
      setTimeout(() => { if (armed?.mode === 'keep' && !disposed) { armed = null; renderKeep(current.result); } }, 4000)?.unref?.();
      return;
    }
    armed = null;
    const count = keepCount(result), decisions = keepTopDecisions(result.groupMembers, count);
    if (!decisions.length) return;
    saving++; renderKeep(result);
    try {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(result.runId)}/decisions`, {
        method: 'POST', headers: starHeaders(), body: JSON.stringify({ decisions }) });
      if (!response.ok) throw new Error('决定保存失败');
      live.schedule(result.runId, decisions.map(row => row.unitId));
      for (const row of decisions) patchQueue(row.unitId, row.action);
      const warning = await applyEagleStars(eagle, (await response.json().catch(() => ({}))).eagleStars);
      note(warning || `已保留前 ${count} 张，其余淘汰（改了 ${decisions.length} 张）`);
    } catch (error) { note(`保存失败：${error.message}`); } finally {
      saving--; lastKey = ''; lastFetch = 0; await refresh(true);
    }
  }
  function toggleExpanded(groupId) {
    sessionSet(SESSION.expanded, sessionGet(SESSION.expanded) === groupId ? null : groupId);
    render(current.state, current.result, current.selected);
  }
  // Concrete differences first; the score summary only when nothing concrete separates the two photos.
  function renderDifference(node, result) {
    node.replaceChildren?.();
    const lines = result ? contrastLines(result.groupMembers, result.unitId) : [];
    if (lines.length && node.append) {
      for (const line of lines) {
        const row = root.createElement('span');
        row.className = `contrast ${line.tone}`; row.textContent = line.text;
        node.append(row);
      }
    } else node.textContent = result ? differenceLine(result.groupMembers, result.unitId) : '';
    node.hidden = !lines.length && !node.textContent;
  }
  function rememberObservationFrame(unitId, frame, image) {
    const frames = observationFrames.get(unitId) || [];
    frames.push({ frame, image }); observationFrames.set(unitId, frames);
  }
  function clearObservationBoxes() {
    for (const overlay of observationOverlays) overlay.remove?.();
    observationOverlays = [];
  }
  function showObservationBox(unitId, box) {
    clearObservationBoxes();
    if (!root.createElementNS || !Array.isArray(box) || box.length !== 4
      || !box.every(value => Number.isFinite(value) && value >= 0 && value <= 1) || box[2] <= box[0] || box[3] <= box[1]) return;
    for (const { frame, image } of observationFrames.get(unitId) || []) {
      const svg = root.createElementNS(SVG, 'svg'), rect = root.createElementNS(SVG, 'rect');
      svg.setAttribute('class', 'marks observation-box'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      rect.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(rect);
      const draw = () => {
        const w = image.naturalWidth, h = image.naturalHeight;
        if (!w || !h) return;
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        for (const [key, value] of Object.entries({ x: box[0] * w, y: box[1] * h,
          width: (box[2] - box[0]) * w, height: (box[3] - box[1]) * h })) rect.setAttribute(key, String(value));
      };
      if (image.complete && image.naturalWidth) draw(); else image.addEventListener?.('load', draw, { once: true });
      frame.append(svg); observationOverlays.push(svg);
    }
  }
  function renderObservations(result) {
    const section = el('observations'), list = el('observationList');
    if (!section || !list) return;
    const items = observationLines(result?.observations);
    section.hidden = !items.length;
    list.replaceChildren(...items.map(item => {
      const row = root.createElement('span'); row.className = item.className;
      row.textContent = item.text; row.title = item.title;
      if (item.box) {
        row.tabIndex = 0;
        row.addEventListener?.('mouseenter', () => showObservationBox(result.unitId, item.box));
        row.addEventListener?.('mouseleave', clearObservationBoxes);
        row.addEventListener?.('focus', () => showObservationBox(result.unitId, item.box));
        row.addEventListener?.('blur', clearObservationBoxes);
      }
      return row;
    }));
  }
  // The middle browser already shows the whole group; the panel only puts this photo next to the one it competes with.
  function renderPair(result) {
    const pair = el('pair'); if (!pair) return;
    const members = result?.groupMembers || [];
    const index = members.findIndex(member => member.unitId === result?.unitId);
    pair.hidden = index < 0 || members.length < 2;
    if (pair.hidden) { pair.replaceChildren(); return; }
    const other = members[index === 0 ? 1 : 0];
    pair.replaceChildren(...[[members[index], '当前'], [other, `第 ${other.rank} 名`]].map(([member, label]) => {
      const node = root.createElement('button');
      node.type = 'button'; node.className = 'member'; node.dataset.suggested = member.suggested;
      if (member === members[index]) node.classList.add('current');
      const flags = (member.flags || []).map(flag => FLAG_LABELS[flag]).filter(Boolean);
      node.title = [`第 ${member.rank} 名`, `AI 建议${ACTION_NAMES[member.suggested]}`,
        member.human ? `你的决定：${MARKS[member.human]}` : '', ...flags].filter(Boolean).join(' · ');
      const image = pooledImage(previewUrl(result.runId, member.unitId));
      rememberObservationFrame(member.unitId, node, image);
      const badge = root.createElement('span'); badge.className = 'badge';
      badge.textContent = `${label === '当前' ? `当前 · 第 ${member.rank} 名` : label} · ${BADGES[member.suggested] || '候'}`;
      node.append(image); drawMarks(node, image, member.marks); node.append(badge);
      if (member.human) {
        const mark = root.createElement('span'); mark.className = 'mark'; mark.textContent = MARKS[member.human]; node.append(mark);
      }
      if (flags.length) {
        const flag = root.createElement('span'); flag.className = 'flag'; flag.textContent = flags.join('、'); node.append(flag);
      }
      node.addEventListener?.('click', () => select(member.itemIds));
      return node;
    }));
  }
  function loadQueue(runId) {
    const cached = queue.runId === runId ? null : sessionGet(SESSION.queue);
    if (cached?.runId === runId && now() - cached.at < QUEUE_TTL) {
      queue = { runId, rows: patchRows(cached.rows, current.result?.runId === runId ? current.result.groupMembers : []),
        at: cached.at };
    }
    if (!runId || (queue.runId === runId && now() - queue.at < QUEUE_TTL) || queueLoad?.runId === runId) return queueLoad?.promise;
    const promise = (async () => {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/queue?mode=all`,
        { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const body = await response.json();
      queue = { runId, rows: patchRows(body.queue || body.items || [],
        current.result?.runId === runId ? current.result.groupMembers : []), at: now() };
      saveQueue();
      if (!disposed && visible && current.result?.runId === runId) render(current.state, current.result, current.selected);
    })().catch(() => {}).finally(() => { if (queueLoad?.promise === promise) queueLoad = null; });
    queueLoad = { runId, promise };
    return promise;
  }
  const staleQueue = () => { queue = { ...queue, at: 0 }; saveQueue(); };
  async function refresh(force = false) {
    if (!visible || disposed) return;
    let token = version;
    try {
      if (current.state !== 'result' || force) trace(`refresh v${token} force=${force} parent=${globalThis.parentID ?? '-'}`, storage);
      const selected = await eagle?.item?.getSelected?.() || [];
      if (current.state !== 'result' || force) trace(`selected ${selected.length} v${token}/${version}`, storage);
      if (token !== version) return;
      const item = selected[0] || null;
      const libraryPath = eagle?.library?.path || '';
      const ids = JSON.stringify([baseUrl(), libraryPath, selectedIds(selected)]);
      const key = JSON.stringify([ids, selected.map(candidate => candidate.star ?? 0)]);
      if (!force && lastKey === key && current.state !== 'offline' && now() - lastFetch < 15000) return;
      // A new star on the same photos is saved by a star watcher shortly after; read once more next poll.
      const starOnly = lastKey && JSON.parse(lastKey)[0] === ids && lastKey !== key;
      token = ++version; lastKey = key; lastFetch = starOnly ? 0 : now();
      if (!item) { render('empty', null, []); return; }
      if (selected.length > MULTI_LIMIT) { render('many', null, selected); return; }
      if (current.state !== 'result') render('loading', null, selected);
      const response = await fetchImpl(`${baseUrl()}/items/${encodeURIComponent(item.id || item)}/analysis`
        + `?libraryPath=${encodeURIComponent(libraryPath)}`, { signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (token !== version || disposed || !visible) return;
      if (!response.ok) { render(response.status === 404 ? 'empty' : 'offline', result, selected); return; }
      result.selectedCount = selected.length;
      if (queue.runId === result.runId) {
        const rows = patchRows(queue.rows, result.groupMembers);
        if (rows !== queue.rows) { queue = { ...queue, rows }; saveQueue(); }
      }
      render('result', result, selected);
      void loadQueue(result.runId);
    } catch (error) {
      trace(`refresh failed ${String(error?.message || error).slice(0, 80)}`, storage);
      // Eagle's API only works after plugin-create; keep the restored view until then instead of showing 离线.
      if (String(error?.message || error).includes('plugin-create')) return;
      if (token === version && !disposed && visible) render('offline');
    }
  }
  async function poll() {
    await refresh();
    if (visible && !disposed) timer = setTimeout(poll, 1500);
  }
  // Stars typed in Eagle become decisions even when the main plugin window is closed.
  const watcher = createStarWatcher({ eagle, storage, post: async ({ id, action }) => {
    const libraryPath = eagle?.library?.path || '';
    const response = await fetchImpl(`${baseUrl()}/items/${encodeURIComponent(id)}/decision`, { method: 'POST',
      headers: { 'content-type': 'application/json', [STAR_HEADER]: '1' },
      body: JSON.stringify({ libraryPath, action, via: 'eagle-star' }) });
    if (response.status >= 400 && response.status < 500) return;
    if (!response.ok) throw new Error('决定保存失败');
    const body = await response.json().catch(() => ({}));
    // Also when unchanged: the main window's star watcher may have saved the same star first.
    if (body.runId && body.unitId) {
      live.schedule(body.runId, [body.unitId]); patchQueue(body.unitId, action === 'clear' ? null : action);
    }
    await applyEagleStars(eagle, body.eagleStars);
    lastKey = ''; lastFetch = 0;
  } });
  const codeReload = createCodeReload({ fetchStamp: () => fetchPluginStamp(baseUrl(), fetchImpl),
    isIdle: () => saving === 0, reload: () => globalThis.location?.reload() });
  // Eagle puts the selected photo's id in this page's URL. When it belongs to the group shown last, draw that group
  // straight away from the cache; the real analysis replaces it moments later.
  function renderFromCache() {
    let id = null;
    try { id = new URL(pageUrl).searchParams.get('id'); } catch { return; }
    const cached = sessionGet(SESSION.group);
    if (!id || !cached?.result) return;
    const stored = sessionGet(SESSION.queue);
    if (stored?.runId === cached.runId) queue = { runId: stored.runId, rows: stored.rows, at: stored.at };
    renderMember(cached.result, id, [id]);
  }
  // Draws a photo of the group already on screen; the real analysis replaces it moments later.
  function renderMember(result, id, ids) {
    const member = result?.groupMembers?.find(row => (row.itemIds || []).includes(id));
    if (!member) return false;
    render('result', { ...result, unitId: member.unitId, rank: member.rank, suggested: member.suggested,
      action: member.human || member.suggested, humanDecided: Boolean(member.human), flags: member.flags || [],
      aiTags: member.aiTags || [], observations: member.observations || [],
      score: member.metrics?.score ?? null, reasons: [], humanReason: null }, ids.map(item => ({ id: item })));
    return true;
  }
  function setVisible(value) {
    trace(`visible ${value}`, storage);
    visible = value; version++; clearTimeout(timer);
    if (value) {
      lastKey = ''; void poll();
      if (eagle?.item?.getSelected) { watcher.start(); codeReload.start(); }
    } else { watcher.stop(); codeReload.stop(); void live.flush(); }
  }
  async function decide(action) {
    if (current.state !== 'result' || !current.selected.length) return;
    const before = current.result, units = selectedUnits();
    const single = units.count <= 1;
    // One request per photo unit; items outside the run are sent as they are and may 404.
    const ids = units.units.length ? [...units.units.map(unit => unit.primaryItemId || unitItems(unit)[0]),
      ...selectedIds().filter(id => !units.units.some(unit => unitItems(unit).includes(id)))] : selectedIds();
    if (single) render('result', { ...before, action: action === 'clear' ? before.suggested : action,
      humanDecided: action !== 'clear' }, current.selected);
    const libraryPath = eagle?.library?.path || '';
    saving++;
    try {
      await Promise.all(ids.map(id => fetchImpl(`${baseUrl()}/items/${encodeURIComponent(id)}/decision`
        + `?libraryPath=${encodeURIComponent(libraryPath)}`, { method: 'POST', headers: starHeaders(),
        body: JSON.stringify({ libraryPath, action }) }).then(async response => {
        if (!response.ok && !(ids.length > 1 && response.status === 404)) throw new Error('决定保存失败');
        const body = await response.json().catch(() => ({}));
        if (body.runId && body.unitId) {
          live.schedule(body.runId, [body.unitId]); patchQueue(body.unitId, action === 'clear' ? null : action);
        }
        return applyEagleStars(eagle, body.eagleStars);
      })));
      lastKey = ''; lastFetch = 0;
      if (!single) note(`已把 ${ids.length} 张标为${ACTION_NAMES[action] || '恢复 AI 建议'}`);
      if (storage.getItem(ADVANCE_KEY) === '1' && single) await nextUndecidedPhoto();
      else await refresh(true);
    } catch (error) {
      render('result', before, current.selected);
      note(`保存失败：${error.message}`);
    } finally { saving--; }
  }
  async function acceptGroup() {
    const result = current.result;
    const undecided = (result?.groupMembers || []).filter(member => !member.human);
    if (!undecided.length) return;
    saving++;
    try {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(result.runId)}/decisions`, {
        method: 'POST', headers: starHeaders(),
        body: JSON.stringify({ decisions: undecided.map(member => ({ unitId: member.unitId, action: member.suggested,
          reason: '接受 AI 建议' })) }) });
      if (!response.ok) throw new Error('决定保存失败');
      const body = await response.json().catch(() => ({}));
      live.schedule(result.runId, undecided.map(member => member.unitId));
      const warning = await applyEagleStars(eagle, body.eagleStars);
      note(warning || `已按 AI 建议决定 ${undecided.length} 张`);
      for (const member of undecided) patchQueue(member.unitId, member.suggested);
      lastKey = ''; lastFetch = 0;
      await refresh(true);
    } catch (error) { note(`保存失败：${error.message}`); } finally { saving--; }
  }
  // Which group fixes make sense for the current photo or the selected photos (all in one group).
  function regroupPlan() {
    const result = current.result, units = selectedUnits();
    if (units.groupCount > 1 || units.unknown) return null;
    const moving = units.units.length ? units.units : [{ unitId: result.unitId, groupId: result.groupId }];
    const groups = runGroups(runRows());
    const position = groups.findIndex(group => group.groupId === (moving[0].groupId ?? result.groupId));
    if (position < 0) return null;
    const group = groups[position], prev = groups[position - 1], next = groups[position + 1];
    const ids = moving.map(unit => unit.unitId);
    return { group, ids, prev: prev && { type: 'move', bodies: ids.map(unitId => ({ unitId, targetGroupId: prev.groupId })) },
      next: next && { type: 'move', bodies: ids.map(unitId => ({ unitId, targetGroupId: next.groupId })) },
      alone: ids.length < group.units.length && (ids.length === 1
        ? { type: 'move', bodies: [{ unitId: ids[0], targetGroupId: 'new' }] }
        : { type: 'split', bodies: [{ groupId: group.groupId, unitIds: ids }] }),
      merge: prev && { type: 'merge', bodies: [{ groupIds: [prev.groupId, group.groupId] }] } };
  }
  async function regroup(mode) {
    const runId = current.result?.runId; if (!runId) return;
    const step = mode === 'undo' ? { type: 'undo', bodies: Array.from({ length: regroupUndo }, () => ({})) }
      : regroupPlan()?.[mode];
    if (!step?.bodies.length) return;
    saving++; renderRun();
    let done = 0;
    try {
      for (const body of step.bodies) {
        const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/groups/${step.type}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '分组修正失败');
        done++;
      }
      note(mode === 'undo' ? '已撤销分组修正' : '分组已修正，人工决定已保留');
    } catch (error) { note(`分组修正失败：${error.message}`); } finally {
      regroupUndo = mode === 'undo' ? regroupUndo - done : regroupUndo + done;
      saving--;
      queue = { ...queue, at: 0 }; lastKey = ''; lastFetch = 0;
      await refresh(true);
    }
  }
  const BULK = {
    eyes: { label: '闭眼的标淘汰', reason: '闭眼', pick: row => (row.unitFlags || row.flags || []).includes('eyes-closed'),
      action: () => 'rejected' },
    blurry: { label: '模糊的标淘汰', reason: '模糊', pick: row => (row.unitFlags || row.flags || []).includes('blurry'),
      action: () => 'rejected' },
    accept: { label: '未定的全按 AI 建议', reason: '接受 AI 建议', pick: () => true, action: row => row.suggested }
  };
  function bulkDecisions(mode) {
    const spec = BULK[mode];
    return spec ? runRows().filter(row => !row.human && spec.pick(row))
      .map(row => ({ unitId: row.unitId, action: spec.action(row), reason: spec.reason })) : [];
  }
  // First click arms the button for a few seconds; the second click within that time saves.
  async function bulk(mode) {
    if (armed?.mode !== mode || now() - armed.at > 4000) {
      armed = { mode, at: now() }; renderRun();
      setTimeout(() => { if (armed?.mode === mode && !disposed) { armed = null; renderRun(); } }, 4000)?.unref?.();
      return;
    }
    armed = null;
    const decisions = bulkDecisions(mode), runId = current.result?.runId;
    if (!decisions.length || !runId) { renderRun(); return; }
    saving++; renderRun();
    try {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/decisions`, {
        method: 'POST', headers: starHeaders(), body: JSON.stringify({ decisions }) });
      if (!response.ok) throw new Error('决定保存失败');
      live.schedule(runId, decisions.map(row => row.unitId));
      const warning = await applyEagleStars(eagle, (await response.json().catch(() => ({}))).eagleStars);
      note(warning || `已决定 ${decisions.length} 张`);
    } catch (error) { note(`保存失败：${error.message}`); } finally {
      saving--;
      queue = { ...queue, at: 0 }; lastKey = ''; lastFetch = 0;
      await loadQueue(runId); await refresh(true);
    }
  }
  function renderAiTagActions() {
    const runId = current.state === 'result' ? current.result?.runId : null;
    const count = new Set(runRows().flatMap(row => unitItems(row))).size;
    for (const button of root.querySelectorAll?.('[data-ai-tags]') || []) {
      const mode = button.dataset.aiTags;
      const armed = aiTagsArmed?.runId === runId && aiTagsArmed.mode === mode;
      button.disabled = aiTagsBusy || saving > 0 || !runId || !count;
      button.textContent = armed ? `再点一次：${mode === 'apply' ? '写入' : '清除'} ${count} 张`
        : mode === 'apply' ? '写入 AI 标签到 Eagle' : '清除 AI 标签';
    }
    const status = el('aiTagsStatus'); if (status) status.textContent = aiTagsStatus;
  }
  async function writeAiTags(mode) {
    const runId = current.state === 'result' ? current.result?.runId : null;
    if (!runId || aiTagsBusy || saving > 0 || !runRows().length || !['apply', 'clear'].includes(mode)) return;
    if (aiTagsArmed?.runId !== runId || aiTagsArmed.mode !== mode || now() - aiTagsArmed.at >= 4000) {
      clearTimeout(aiTagsTimer); aiTagsArmed = { runId, mode, at: now() }; aiTagsStatus = '';
      renderAiTagActions(); saveSnapshot();
      aiTagsTimer = setTimeout(() => {
        aiTagsArmed = null; if (!disposed) { renderAiTagActions(); saveSnapshot(); }
      }, 4000); aiTagsTimer?.unref?.(); return;
    }
    clearTimeout(aiTagsTimer); aiTagsArmed = null; aiTagsBusy = true; saving++;
    aiTagsStatus = '正在处理 AI 标签…'; renderAiTagActions(); saveSnapshot();
    try {
      const response = await fetchImpl(`${baseUrl()}/runs/${encodeURIComponent(runId)}/ai-tags/${mode}`,
        { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '操作失败');
      aiTagsStatus = `${mode === 'apply' ? '已写入' : '已清除'} ${body.updated || 0} 张`
        + (body.failed ? `，${body.failed} 张失败，可重试` : '');
    } catch (error) { aiTagsStatus = `AI 标签操作失败：${error.message}`; }
    finally { aiTagsBusy = false; saving--; if (!disposed) { renderAiTagActions(); saveSnapshot(); } }
  }
  async function nextUndecidedPhoto() {
    const runId = current.result?.runId; if (!runId) return;
    await loadQueue(runId);
    const rows = runRows();
    const next = nextInQueue(rows.filter(row => !row.human), current.result?.unitId, rows.map(row => row.unitId));
    if (!next) { await refresh(true); return; }
    note(`已跳到第 ${next.groupIndex + 1} 组第 ${next.rank} 名（下一张未决定）`, { carry: true });
    select(unitItems(next));
  }
  // Eagle selects the photo but does not scroll its middle browser to it; say where we went.
  function navigate(mode) {
    const result = current.result; if (!result) return;
    const target = groupTarget(runGroups(runRows()), result.groupId, mode);
    if (!target?.unit) return;
    note(`已在 Eagle 中选中第 ${target.group.groupIndex + 1} 组第 ${target.unit.rank} 名；在中间按 5/3/1 可直接打星。`,
      { carry: true });
    select(unitItems(target.unit));
  }
  for (const button of root.querySelectorAll?.('[data-decision]') || [])
    button.addEventListener?.('click', () => void decide(button.dataset.decision));
  for (const button of root.querySelectorAll?.('[data-nav]') || [])
    button.addEventListener?.('click', () => navigate(button.dataset.nav));
  el('selectGroup')?.addEventListener?.('click', () => select(current.result?.groupItemIds || []));
  el('selectUndecided')?.addEventListener?.('click', () =>
    select((current.result?.groupMembers || []).filter(member => !member.human).flatMap(member => member.itemIds)));
  el('acceptGroup')?.addEventListener?.('click', () => void acceptGroup());
  el('expandTable')?.addEventListener?.('click', () => { if (current.result?.groupId) toggleExpanded(current.result.groupId); });
  for (const button of root.querySelectorAll?.('[data-keep]') || [])
    button.addEventListener?.('click', () => stepKeep(Number(button.dataset.keep)));
  el('keepApply')?.addEventListener?.('click', () => void applyKeep());
  for (const button of root.querySelectorAll?.('[data-regroup]') || [])
    button.addEventListener?.('click', () => void regroup(button.dataset.regroup));
  for (const button of root.querySelectorAll?.('[data-bulk]') || [])
    button.addEventListener?.('click', () => void bulk(button.dataset.bulk));
  for (const button of root.querySelectorAll?.('[data-ai-tags]') || [])
    button.addEventListener?.('click', () => void writeAiTags(button.dataset.aiTags));
  el('personalizeApply')?.addEventListener?.('click', () => void personalize());
  el('personalizeUndo')?.addEventListener?.('click', () => void personalize('undo'));
  el('marksOn')?.addEventListener?.('change', () => {
    storage.setItem(MARKS_KEY, el('marksOn').checked ? '1' : '0');
    if (current.state === 'result') render(current.state, current.result, current.selected);
  });
  for (const fold of root.querySelectorAll?.('details') || []) fold.addEventListener?.('toggle', () => saveSnapshot());
  const advance = el('autoAdvance');
  if (advance) {
    advance.checked = storage.getItem(ADVANCE_KEY) === '1';
    advance.addEventListener?.('change', () => storage.setItem(ADVANCE_KEY, advance.checked ? '1' : '0'));
  }
  root.addEventListener?.('keydown', event => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    const action = STAR_ACTIONS[event.key];
    if (action) { event.preventDefault(); void decide(action); }
  });
  // The theme may not be readable while the page loads; read it again once Eagle has created the panel.
  eagle?.onPluginCreate?.(() => { trace('plugin-create', storage); void initEagleTheme({ eagle, doc: root }); setVisible(true); });
  eagle?.onPluginShow?.(() => { void initEagleTheme({ eagle, doc: root }); setVisible(true); });
  eagle?.onPluginHide?.(() => setVisible(false));
  eagle?.onLibraryChanged?.(() => {
    lastKey = ''; version++; watcher.reset(); queue = { runId: null, rows: [], at: 0 }; if (visible) void refresh(true);
  });
  root.addEventListener?.('visibilitychange', () => setVisible(!root.hidden));
  const carried = sessionGet(SESSION.note);
  try { session?.removeItem(SESSION.note); } catch { /* ignore */ }
  if (carried?.text && now() - carried.at < 10000) note(carried.text);
  renderFromCache();
  if (visible) setVisible(true);
  const dispose = () => {
    disposed = true; version++; clearTimeout(timer); clearTimeout(personalTimer); clearTimeout(aiTagsTimer);
    watcher.stop(); codeReload.stop(); void live.flush();
  };
  globalThis.addEventListener?.('pagehide', dispose);
  return { refresh, setVisible, watcher, dispose, navigate, acceptGroup, loadQueue, regroup, bulk, stepKeep, applyKeep,
    personalize, loadPersonalization, writeAiTags };
}
if (typeof document !== 'undefined' && document.querySelector('#inspector')) mountInspector();
