import { readRows } from '../core/segmented-results.js';
import { DecisionsStore } from '../core/decisions-store.js';
import { json } from './http.js';
import { deriveTags } from '../core/ai-tags.js';
import { aestheticForResult } from '../core/aesthetic-head.js';
import { photoFacts } from '../core/photo-facts.js';
import { observationsFor } from '../core/observations.js';

export function resultAiTags(data, result = {}) {
  const unit = data.units?.find(row => row.id === result.unitId);
  const item = data.items?.find(row => row.id === unit?.primaryItemId) || {};
  return Array.isArray(result.aiTags) ? result.aiTags : deriveTags(result, item);
}

const finite = value => Number.isFinite(value) ? value : null;
// The least open eye among the assessed faces, 0 (shut) to 1 (wide open), from the per-eye blink probabilities.
function eyesOpen(faces = []) {
  const open = faces.filter(face => face?.eyesAssessed)
    .map(face => [face.blinkLeft, face.blinkRight].filter(Number.isFinite))
    .filter(blinks => blinks.length).map(blinks => 1 - Math.max(...blinks));
  return open.length ? Math.min(...open) : null;
}
// Height of the largest face as a share of the frame height: how close or tight the shot is.
function faceSize(faces = []) {
  const heights = faces.map(face => face?.box).filter(box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite))
    .map(box => box[3] - box[1]).filter(height => height > 0);
  return heights.length ? Math.max(...heights) : null;
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; na += a[index] ** 2; nb += b[index] ** 2; }
  return na > 0 && nb > 0 ? Math.max(0, Math.min(1, dot / Math.sqrt(na * nb))) : null;
}
function memberMetrics(result = {}, ranking = {}, best = null) {
  const metrics = result.metrics || {};
  const clipped = [metrics.clippedHighlights, metrics.clippedShadows].filter(Number.isFinite);
  return { score: finite(ranking.score ?? result.score), quality: finite(metrics.quality),
    aesthetic: finite(aestheticForResult(result)),
    sharpness: finite(metrics.sharpness), eye: finite(result.focus?.eyeSharpnessNative),
    exposure: finite(metrics.exposure), clipped: clipped.length ? clipped.reduce((a, b) => a + b, 0) : null,
    faces: finite(metrics.faces), eyesClosed: finite(metrics.eyesClosed),
    eyesOpen: finite(eyesOpen(result.faces)), faceSize: finite(faceSize(result.faces)),
    similar: best && best !== result ? finite(cosine(result.embedding, best.embedding)) : null };
}

const round3 = value => Math.round(value * 1000) / 1000;
const isBox = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);
// Face boxes with the blink verdict and, when pose ran, each person's box and 17 COCO body keypoints [x, y, score],
// all normalised to the preview, for drawing on thumbnails.
export function memberMarks(result = {}) {
  const faces = (result.faces || []).filter(face => isBox(face?.box)).map(face => ({ box: face.box.map(round3),
    ...(face.eyesAssessed ? { closed: Boolean(face.eyesClosed) } : {}) }));
  const persons = (result.signals?.persons || []).filter(person => isBox(person?.box)).map(person => ({
    box: person.box.map(round3), main: Boolean(person.isMain),
    points: (person.keypoints?.points || []).slice(0, 17).map(point => point.slice(0, 3).map(round3)) }));
  return faces.length || persons.length ? { faces, persons } : null;
}

// One row per photo unit in the group, in AI rank order, for the inspector's group strip and comparison table.
export function groupMembersModel(data, group, decisions = []) {
  if (!group) return [];
  const ranking = new Map((group.ranking || []).map(row => [row.unitId, row]));
  const human = new Map(decisions.filter(row => row.source === 'human').map(row => [row.unitId, row.action]));
  const bestId = (group.ranking || []).find(row => row.rank === 1)?.unitId ?? group.unitIds[0];
  const best = data.results.find(row => row.unitId === bestId) || null;
  return group.unitIds.map((id, index) => {
    const unit = data.units.find(row => row.id === id);
    const result = data.results.find(row => row.unitId === id);
    return { unitId: id, primaryItemId: unit?.primaryItemId || unit?.itemIds?.[0] || null,
      itemIds: unit?.itemIds?.length ? unit.itemIds : [unit?.primaryItemId].filter(Boolean),
      rank: ranking.get(id)?.rank ?? index + 1, suggested: group.suggested?.[id] || 'candidate',
      human: human.get(id) || null, flags: result?.flags || [], metrics: memberMetrics(result, ranking.get(id), best),
      aiTags: resultAiTags(data, result), name: result?.name || null, reasons: ranking.get(id)?.reasons || [], marks: memberMarks(result),
      facts: result ? photoFacts(result) : null, observations: observationsFor(result) };
  }).sort((a, b) => a.rank - b.rank);
}

export function itemAnalysisModel(data, unitId, decision, decisions = decision ? [decision] : []) {
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
    groupItemIds, bestItemId, groupMembers: groupMembersModel(data, group, decisions),
    groupConfidence: group?.confidence || null,
    analyzedAt: data.run.completedAt || data.run.startedAt || null,
    suggested, action: decision?.source === 'human' ? decision.action : suggested,
    humanDecided: decision?.source === 'human', rank: ranking.rank ?? null, groupSize: group?.unitIds.length || 1,
    score: ranking.score ?? result.score ?? null, quality: result.metrics?.quality ?? null,
    focus: flags.includes('blurry') ? '模糊' : flags.includes('possibly-blurry') ? '可能模糊'
      : result.focus?.status === 'ok' || Number.isFinite(result.metrics?.sharpness) ? '清晰' : '无法判断',
    eyeSharpness: result.focus?.eyeSharpnessNative ?? null,
    observations: observationsFor(result), aiTags: resultAiTags(data, result),
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
      if (page?.units?.length) data = { ...data, units: page.units, results: page.results?.length ? page.results : data.results };
    }
    const decisions = await new DecisionsStore(this.store.dir(match.runId)).read();
    return { itemId, ...itemAnalysisModel(data, match.unitId, decisions.find(row => row.unitId === match.unitId), decisions) };
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
