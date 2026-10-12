// Pure queue logic for the focused cull view. Rows come from GET /runs/:id/queue (one row per photo unit).
export const ISSUE_FLAGS = new Set(['eyes-closed', 'blurry', 'possibly-blurry', 'overexposed', 'underexposed']);
export const ACTION_LABELS = Object.freeze({ selected: '精选', candidate: '候选', rejected: '淘汰' });
export const FLAG_LABELS = Object.freeze({ 'eyes-closed': '闭眼', blurry: '模糊', 'possibly-blurry': '可能模糊',
  overexposed: '过曝', underexposed: '欠曝' });
export const FILTERS = [['all', '全部'], ['undecided', '未决定'], ['uncertain', '没把握'], ['rejects', '建议淘汰'],
  ['issues', '有问题'], ['picked', '已精选']];
export const METHODS = [['loupe', '逐张'], ['grid', '网格'], ['target', 'AI 先挑'], ['passes', '分轮']];
export const PASSES = [
  { id: 'rejects', label: '第 1 轮 · 去废片', hint: '只看建议淘汰和有问题的照片，批量确认或救回' },
  { id: 'compare', label: '第 2 轮 · 组内比较', hint: '连拍和相似照片并排比较，选出每组最好的' },
  { id: 'picks', label: '第 3 轮 · 复核精选', hint: '逐张大图复核已选和建议精选的照片，降级不够好的' }];

export const hasIssue = row => (row.flags || []).some(flag => ISSUE_FLAGS.has(flag));
export const effectiveAction = row => row.human || row.suggested || 'candidate';

export function matchesFilter(row, filter = 'all') {
  switch (filter) {
    case 'undecided': return !row.human;
    case 'uncertain': return row.confidence === 'low' || row.margin === 0
      || (row.groupSize > 1 && row.rank === 1 && (row.reasons || []).length > 1);
    case 'rejects': return row.suggested === 'rejected' && !row.human;
    case 'issues': return hasIssue(row);
    case 'picked': return effectiveAction(row) === 'selected';
    default: return true;
  }
}

export function filterCounts(rows) {
  return Object.fromEntries(FILTERS.map(([id]) => [id, rows.filter(row => matchesFilter(row, id)).length]));
}

export function progress(rows) {
  const decided = rows.filter(row => row.human).length;
  const counts = { selected: 0, candidate: 0, rejected: 0 };
  for (const row of rows) counts[effectiveAction(row)] = (counts[effectiveAction(row)] || 0) + 1;
  return { decided, total: rows.length, ...counts };
}

// Diversity first: every group's best shot is ranked before any second-best, then by score.
export function targetOrder(rows) {
  return [...rows].sort((a, b) => (a.rank || 1) - (b.rank || 1) || (b.score ?? -Infinity) - (a.score ?? -Infinity)
    || (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
}

export function defaultTarget(rows) {
  const suggested = rows.filter(row => row.suggested === 'selected').length;
  return suggested || Math.min(rows.length, Math.max(1, Math.round(rows.length * 0.1)));
}

export function targetPlan(rows, target) {
  const order = targetOrder(rows);
  const keep = Math.max(0, Math.min(order.length, Math.round(Number(target) || 0)));
  const width = Math.max(4, Math.ceil(keep * 0.08));
  const keepIds = new Set(order.slice(0, keep).map(row => row.unitId));
  const boundary = new Set(order.slice(Math.max(0, keep - width), keep + width).map(row => row.unitId));
  for (const row of order) {
    if (keepIds.has(row.unitId) && (hasIssue(row) || row.confidence === 'low')) boundary.add(row.unitId);
  }
  const review = order.filter(row => boundary.has(row.unitId));
  const rest = order.filter(row => !boundary.has(row.unitId) && !row.human)
    .map(row => ({ unitId: row.unitId, action: keepIds.has(row.unitId) ? 'selected' : 'rejected' }));
  return { keep, keepIds, review, rest };
}

export function passRows(rows, pass) {
  if (pass === 'rejects') return rows.filter(row => row.suggested === 'rejected' || hasIssue(row));
  if (pass === 'picks') return rows.filter(row => effectiveAction(row) === 'selected');
  return rows.filter(row => row.groupSize > 1);
}

export function nextUndecided(rows, index, delta = 1) {
  for (let step = 1; step <= rows.length; step++) {
    const next = (index + delta * step + rows.length * step) % rows.length;
    if (!rows[next]?.human) return next;
  }
  return -1;
}

export function groupJump(rows, index, delta) {
  const groupId = rows[index]?.groupId;
  if (delta > 0) {
    const next = rows.findIndex((row, offset) => offset > index && row.groupId !== groupId);
    return next < 0 ? index : next;
  }
  let start = index;
  while (start > 0 && rows[start - 1].groupId === groupId) start--;
  if (start === 0) return 0;
  const previousGroup = rows[start - 1].groupId;
  while (start > 0 && rows[start - 1].groupId === previousGroup) start--;
  return start;
}

export function rangeSelect(rows, anchorId, targetId) {
  const a = rows.findIndex(row => row.unitId === anchorId), b = rows.findIndex(row => row.unitId === targetId);
  if (a < 0 || b < 0) return [targetId];
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(row => row.unitId);
}

export function applyDecisionLocally(row, action) {
  row.human = action === 'clear' ? null : action;
  row.action = row.human || row.suggested;
  return row;
}

export const KEY_ACTIONS = Object.freeze({ 1: 'selected', 2: 'candidate', 3: 'rejected', 0: 'clear',
  p: 'selected', x: 'rejected', u: 'clear' });
