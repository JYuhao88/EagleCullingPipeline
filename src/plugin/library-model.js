// Presentation rules for the library view and for where the current selection stands; see docs/ux-design.md.
import { durationText } from './start-model.js';

// One place (a folder, or the photos in no folder): analyzed, partly analyzed, not analyzed, queued or running.
export function placeStatus({ count = 0, analyzed = 0, queued = null, running = null } = {}) {
  if (running !== null && running !== undefined) return { state: 'running', chip: `分析中 ${Math.floor(running)}%` };
  if (queued) return { state: 'queued', chip: `排队第 ${queued}` };
  if (!count) return { state: 'empty', chip: '' };
  if (analyzed >= count) return { state: 'done', chip: '✓ 已分析' };
  if (analyzed > 0) return { state: 'partial', chip: `◐ 已分析 ${analyzed}/${count}` };
  return { state: 'none', chip: '○ 未分析' };
}

export function librarySummary(overview) {
  if (!overview) return '';
  const left = overview.total - overview.analyzed;
  return [`资源库 ${overview.total} 张`, `已分析 ${overview.analyzed}`, left ? `未分析 ${left}` : '',
    overview.queue?.length ? `排队 ${overview.queue.length} 个` : ''].filter(Boolean).join(' · ');
}

// The folder tree as indented rows. Folders without photos anywhere below are left out; `expanded` holds open ids.
export function folderRows(overview, expanded = new Set()) {
  const rows = [];
  const visit = (folder, depth) => {
    if (!folder.subtree?.count) return;
    const children = folder.children.filter(child => child.subtree?.count);
    rows.push({ ...folder, depth, hasChildren: children.length > 0, open: expanded.has(folder.id) });
    if (expanded.has(folder.id)) for (const child of children) visit(child, depth + 1);
  };
  for (const folder of overview?.folders || []) visit(folder, 0);
  if (overview?.unfiled?.count) rows.push({ ...overview.unfiled, id: null, name: '未归入文件夹', depth: 0, unfiled: true,
    subtree: { count: overview.unfiled.count, analyzed: overview.unfiled.analyzed } });
  return rows;
}

// Folders open at first: every folder when the tree is small, otherwise only the top level.
export function initialExpanded(overview, limit = 40) {
  const ids = [], top = [];
  const visit = (folder, depth) => {
    if (!folder.subtree?.count) return;
    ids.push(folder.id); if (depth === 0) top.push(folder.id);
    folder.children.forEach(child => visit(child, depth + 1));
  };
  (overview?.folders || []).forEach(folder => visit(folder, 0));
  return new Set(ids.length <= limit ? ids : top);
}

export function rowDetail(row) {
  const own = row.count ? `${row.count} 张` : '';
  const below = row.hasChildren && row.subtree.count !== row.count
    ? `含子文件夹 ${row.subtree.count} 张，已分析 ${row.subtree.analyzed}` : '';
  return [own, below].filter(Boolean).join(' · ');
}

// The home card while photos are selected that are not all analyzed. Selecting only shows where they are;
// analysis starts only from an explicit 排队.
export function locateCard({ name, location, match, submitting = false, secondsPerPhoto = null, photos = 0 }) {
  const base = { kind: 'locate', eyebrow: name, secondary: [], more: [] };
  if (match?.run && match.matched > 0) base.secondary.push({ label: '先挑已分析的', action: 'openMatch' });
  if (!location) return { ...base, title: name, detail: '正在查找所在文件夹…', action: null };
  if (photos) base.more.push({ label: `只分析选中的 ${photos} 张`, action: 'queueSelection' });
  const scopes = location.scopes || [];
  const open = scopes.filter(scope => placeStatus(scope).state === 'none' || placeStatus(scope).state === 'partial');
  const pending = '没分析完也可以先打分、打标签，分析完成后自动并入。';
  if (scopes.length === 1) {
    const scope = scopes[0], status = placeStatus(scope);
    if (status.state === 'running') {
      return { ...base, title: `「${scope.label}」正在分析 ${Math.floor(scope.running)}%`, detail: pending, action: null };
    }
    if (status.state === 'queued') {
      return { ...base, title: `「${scope.label}」排队第 ${scope.queued}`, detail: `轮到时自动开始。${pending}`, action: null };
    }
    const estimate = secondsPerPhoto ? `预计约 ${durationText((scope.count - scope.analyzed) * secondsPerPhoto)}。` : '';
    return { ...base, title: `「${scope.label}」已分析 ${scope.analyzed} / ${scope.count}`,
      detail: estimate + (scope.analyzed ? '排队后只补算新照片，分组按整个文件夹重新整理，已做的决定会带上。'
        : '排队后按文件夹分析，一次只跑一个，不影响你继续挑别的。'),
      action: { label: `排队「${scope.label}」`, action: 'queueScopes', disabled: submitting } };
  }
  if (!scopes.length) {
    return { ...base, title: `${name}还没有分析`, detail: '资源库里还没读到这些照片，稍后再看，或在下方「资源库进度」里排队。',
      action: null };
  }
  const waiting = scopes.filter(scope => ['queued', 'running'].includes(placeStatus(scope).state)).length;
  return { ...base, title: `分布在 ${scopes.length} 个文件夹`,
    detail: [scopes.slice(0, 4).map(scope => `${scope.label}（${placeStatus(scope).chip || `${scope.count} 张`}）`).join('、')
      + (scopes.length > 4 ? ` 等` : ''), waiting ? `${waiting} 个已在排队或分析中。` : ''].filter(Boolean).join('。'),
    action: open.length ? { label: `排队这 ${open.length} 个文件夹`, action: 'queueScopes', disabled: submitting } : null };
}
