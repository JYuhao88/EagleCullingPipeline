import { DecisionsStore } from '../core/decisions-store.js';
import { groupConfidence } from '../core/ranking.js';

const MODES = new Set(['all', 'uncertain', 'rejects', 'issues', 'undecided']);
const ISSUE_FLAGS = new Set(['eyes-closed', 'blurry', 'possibly-blurry', 'overexposed', 'underexposed']);

function groupRows(data, decisions) {
  const resultByUnit = new Map((data.results || []).map(row => [row.unitId, row]));
  const decisionByUnit = new Map((decisions || []).map(row => [row.unitId, row]));
  const units = new Map((data.units || []).map(row => [row.id, row]));
  const itemById = new Map((data.items || []).map(row => [row.id, row]));
  return (data.groups || []).flatMap((group, groupIndex) => {
    const confidence = group.confidence ? group : { ...group, ...groupConfidence(group, resultByUnit) };
    const groupFlags = new Set(group.flags || []);
    return (group.ranking || group.unitIds.map((unitId, index) => ({ unitId, rank: index + 1 })))
      .map((ranking, rankIndex) => {
        const unitId = ranking.unitId;
        const unit = units.get(unitId) || {};
        const result = resultByUnit.get(unitId) || {};
        const stored = decisionByUnit.get(unitId);
        const suggested = group.suggested?.[unitId] || 'candidate';
        const human = stored?.source === 'human' ? stored.action : null;
        const flags = [...new Set([...(result.flags || []), ...groupFlags])];
        const primaryItemId = unit.primaryItemId || unit.itemIds?.[0] || null;
        return { unitId, primaryItemId, fileName: itemById.get(primaryItemId)?.name || primaryItemId,
          itemIds: unit.itemIds || [unit.primaryItemId].filter(Boolean), groupId: group.id, groupIndex,
          rank: ranking.rank ?? rankIndex + 1, groupSize: group.unitIds.length, suggested,
          action: human || suggested, human, flags, confidence: confidence.confidence || null,
          score: ranking.score ?? result.score ?? null, margin: confidence.margin ?? null,
          reasons: ranking.reasons || [] };
      });
  });
}

export function filterQueue(rows, mode = 'all') {
  if (!MODES.has(mode)) throw new Error(`未知队列模式：${mode}`);
  return rows.filter(row => mode === 'all' ||
    (mode === 'uncertain' && (row.confidence === 'low' || row.margin === 0 ||
      row.groupSize > 1 && row.rank === 1 && row.reasons?.length > 1)) ||
    (mode === 'rejects' && row.suggested === 'rejected' && !row.human) ||
    (mode === 'issues' && row.flags.some(flag => ISSUE_FLAGS.has(flag))) ||
    (mode === 'undecided' && !row.human));
}

export async function buildQueue(store, runId) {
  let data;
  if (store.page && store.getRun) {
    const run = await store.getRun(runId);
    if (!run) return null;
    const units = [], results = [], items = [], groups = [], seen = new Set();
    let cursor = 0;
    while (true) {
      const page = await store.page(runId, { cursor, limit: 500 });
      if (!page) return null;
      for (const group of page.groups || []) if (!seen.has(group.id)) { seen.add(group.id); groups.push(group); }
      units.push(...(page.units || [])); results.push(...(page.results || [])); items.push(...(page.items || []));
      if (page.page?.nextCursor === null || !page.page?.nextCursor) break;
      cursor = Number(page.page.nextCursor);
    }
    data = { run, units, results, items, groups };
  } else data = await store.get(runId, { readOnly: true });
  if (!data) return null;
  const decisions = await new DecisionsStore(store.dir(runId)).read();
  const rows = groupRows(data, decisions);
  const counts = Object.fromEntries([...MODES].map(mode => [mode, filterQueue(rows, mode).length]));
  return { rows, counts, total: rows.length };
}

export { MODES };
