import { createHash } from 'node:crypto';
import { DecisionsStore } from './decisions-store.js';

// A task is "the culling work for one scope"; re-analysing the same scope is a new version of that task.
export function scopeKey(scope = {}, itemIds = []) {
  if (scope.type === 'library') return 'library';
  if (scope.type === 'unfiled') return 'unfiled';
  if (scope.type === 'folder' && typeof scope.folderId === 'string' && scope.folderId) return `folder:${scope.folderId}`;
  const ids = [...new Set((itemIds || []).filter(id => typeof id === 'string'))].sort();
  if (!ids.length) return null;
  return `selection:${createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)}`;
}

function newer(a, b) {
  return (Date.parse(a?.updatedAt) || 0) > (Date.parse(b?.updatedAt) || 0);
}

// Human decisions follow the photo: units keep the `unit:<primary item>` ID across runs.
export async function inheritDecisions(store, run, unitIds) {
  const wanted = new Set(unitIds);
  if (!wanted.size || !run.libraryPath) return { count: 0, fromRunIds: [] };
  const chosen = new Map();
  for (const other of await store.allRuns()) {
    if (other.id === run.id || other.libraryPath !== run.libraryPath || other.purpose === 'prefetch') continue;
    const rows = await new DecisionsStore(store.dir(other.id)).read().catch(() => []);
    for (const row of rows) {
      if (row.source !== 'human' || !wanted.has(row.unitId)) continue;
      const current = chosen.get(row.unitId);
      if (!current || newer(row, current.row)) chosen.set(row.unitId, { row, runId: row.inheritedFrom || other.id });
    }
  }
  if (!chosen.size) return { count: 0, fromRunIds: [] };
  const target = new DecisionsStore(store.dir(run.id));
  const merged = new Map((await target.read()).map(row => [row.unitId, row]));
  let count = 0;
  for (const [unitId, { row, runId }] of chosen) {
    if (merged.has(unitId)) continue;
    merged.set(unitId, { ...row, inheritedFrom: runId });
    count++;
  }
  await target.write([...merged.values()]);
  return { count, fromRunIds: [...new Set([...chosen.values()].map(entry => entry.runId))] };
}

// Older versions of the same task, or analyses fully contained in the new one, are hidden from the task list.
export async function supersedeOlderRuns(store, run, unitIds) {
  const covered = new Set(unitIds), marked = [];
  for (const other of await store.allRuns()) {
    // Only one analysis runs at a time, so any other "running" record was interrupted.
    if (other.id === run.id || other.libraryPath !== run.libraryPath || other.purpose === 'prefetch' ||
      other.supersededBy) continue;
    if (Date.parse(other.startedAt || 0) > Date.parse(run.startedAt || 0)) continue;
    const sameScope = run.scope?.key && other.scope?.key === run.scope.key;
    const otherUnits = sameScope ? [] : await store.unitIds(other.id);
    if (!sameScope && !(otherUnits.length && otherUnits.every(id => covered.has(id)))) continue;
    await store.writeAtomic(other.id, 'run.json', { ...other, supersededBy: run.id });
    marked.push(other.id);
  }
  return marked;
}
