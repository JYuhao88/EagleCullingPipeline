import { readRows } from '../core/segmented-results.js';
import { DecisionsStore } from '../core/decisions-store.js';
import { json } from './http.js';

export function itemAnalysisModel(data, unitId, decision) {
  const result = data.results.find(row => row.unitId === unitId) || {};
  const group = data.groups.find(row => row.unitIds.includes(unitId));
  const ranking = group?.ranking?.find(row => row.unitId === unitId) || {};
  const suggested = group?.suggested?.[unitId] || 'candidate';
  const flags = result.flags || [];
  const bestItemId = group?.ranking?.find(row => row.rank === 1)?.unitId === unitId
    ? data.units.find(row => row.id === unitId)?.primaryItemId : (() => {
      const best = group?.ranking?.find(row => row.rank === 1);
      return data.units.find(row => row.id === best?.unitId)?.primaryItemId || null;
    })();
  const orderedIds = (group?.ranking || (group?.unitIds || []).map((id, index) => ({ unitId: id, rank: index + 1 })))
    .slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map(row => row.unitId);
  const groupItemIds = orderedIds.flatMap(id => {
    const unit = data.units.find(row => row.id === id); return unit?.itemIds || [unit?.primaryItemId].filter(Boolean);
  });
  return { runId: data.run.id, unitId, runName: data.run.scope?.label || '照片分析',
    taskName: data.run.scope?.label || data.run.id, eagleTagsEnabled: data.run.eagleTagsEnabled === true,
    groupId: group?.id || null, groupIndex: data.groups.findIndex(row => row.id === group?.id),
    groupItemIds, bestItemId,
    analyzedAt: data.run.completedAt || data.run.startedAt || null,
    suggested, action: decision?.source === 'human' ? decision.action : suggested,
    humanDecided: decision?.source === 'human', rank: ranking.rank ?? null, groupSize: group?.unitIds.length || 1,
    score: ranking.score ?? result.score ?? null, quality: result.metrics?.quality ?? null,
    focus: flags.includes('blurry') ? '模糊' : flags.includes('possibly-blurry') ? '可能模糊'
      : result.focus?.status === 'ok' || Number.isFinite(result.metrics?.sharpness) ? '清晰' : '无法判断',
    eyeSharpness: result.focus?.eyeSharpnessNative ?? null,
    flags, reasons: ranking.reasons || [], humanReason: decision?.reason || null };
}

// One index per library; selection reads one unit and its current human decision.
// Store generation changes only when a run is added or results are published.
export class ItemAnalysisIndex {
  constructor(store) { this.store = store; this.libraries = new Map(); }
  async build(libraryPath) {
    const index = new Map();
    for (const run of await this.store.recentRuns(Infinity)) {
      if (run.libraryPath !== libraryPath || run.status !== 'completed' || run.supersededBy) continue;
      const manifest = await this.store.manifest(run.id);
      const units = manifest ? readRows(this.store.dir(run.id), manifest, 'units')
        : (await this.store.results(run.id, { readOnly: true }))?.units || [];
      for await (const unit of units) for (const itemId of unit.itemIds || [unit.primaryItemId]) {
        if (itemId && !index.has(itemId)) index.set(itemId, { runId: run.id, unitId: unit.id });
      }
    }
    return index;
  }
  async get(itemId, libraryPath) {
    const generation = this.store.analysisGeneration || 0;
    let entry = this.libraries.get(libraryPath);
    if (!entry || entry.generation !== generation) {
      entry = { generation, promise: this.build(libraryPath) };
      this.libraries.set(libraryPath, entry);
      while (this.libraries.size > 3) this.libraries.delete(this.libraries.keys().next().value);
    }
    let index;
    try { index = await entry.promise; } catch (error) { this.libraries.delete(libraryPath); throw error; }
    // Do not publish stale results if completion raced the first build.
    if (generation !== (this.store.analysisGeneration || 0)) return this.get(itemId, libraryPath);
    const match = index.get(itemId); if (!match) return null;
    let data = await this.store.unitData(match.runId, match.unitId);
    if (!data?.results.length) return null;
    const group = data.groups?.find(row => row.unitIds.includes(match.unitId));
    if (group && group.unitIds.length > 1 && this.store.page) {
      const page = await this.store.page(match.runId, { groupId: group.id });
      if (page?.units?.length) data = { ...data, units: page.units };
    }
    const decisions = await new DecisionsStore(this.store.dir(match.runId)).read();
    return { itemId, ...itemAnalysisModel(data, match.unitId, decisions.find(row => row.unitId === match.unitId)) };
  }
}
export function createItemAnalysisRouter(store, { onDecision, readBody } = {}) {
  const index = new ItemAnalysisIndex(store);
  return async (req, res, url) => {
    const match = url.pathname.match(/^\/items\/([^/]+)\/(analysis|decision)$/);
    if (!match) return false;
    if (match[2] === 'decision' && req.method === 'POST') {
      if (!onDecision) return json(res, 405, { error: '当前服务不支持按 item 决定' });
      let body;
      try { body = readBody ? await readBody(req) : {}; } catch { return json(res, 400, { error: '请求体不是有效 JSON' }); }
      const libraryPath = url.searchParams.get('libraryPath') || body?.libraryPath;
      if (!libraryPath) return json(res, 400, { error: '需要 libraryPath' });
      const itemId = decodeURIComponent(match[1]);
      const entry = await index.get(itemId, libraryPath);
      if (!entry) return json(res, 404, { error: '尚未分析，在插件中分析后显示' });
      return onDecision(req, res, { ...entry, itemId, libraryPath, body });
    }
    if (match[2] !== 'analysis' || req.method !== 'GET') return json(res, 405, { error: '检查器只支持 GET/POST 决定' });
    const libraryPath = url.searchParams.get('libraryPath');
    if (!libraryPath) return json(res, 400, { error: '需要 libraryPath' });
    const itemId = decodeURIComponent(match[1]);
    const value = await index.get(itemId, libraryPath);
    return value ? json(res, 200, value) : json(res, 404, { error: '尚未分析，在插件中分析后显示' });
  };
}
