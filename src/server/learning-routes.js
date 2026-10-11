import path from 'node:path';
import { LearningData, PROTECTED_LEARNING_LIBRARY } from '../core/learning-data.js';
import { PreferenceStore } from '../core/preference-store.js';
import { eventsToPreferenceGroups, preferenceScore, driftReport } from '../core/preference-head.js';
import { suggestDecision } from '../core/ranking.js';

export function learningServices(ctx) {
  const root = ctx.learningRoot || path.join(path.dirname(ctx.runStore.root), 'learning');
  ctx.learningData ||= new LearningData(root);
  ctx.preferenceStore ||= new PreferenceStore(root);
  return { dataStore: ctx.learningData, profiles: ctx.preferenceStore };
}
export async function learningGroups(dataStore, profileId) {
  const events = (await dataStore.events.read()).filter(event => (event.profileId || 'default') === profileId);
  const features = new Map();
  for (const hash of new Set(events.flatMap(event => [...(event.candidateHashes || []), event.hash].filter(Boolean)))) {
    const feature = await dataStore.features.get(hash);
    if (feature) features.set(hash, feature);
  }
  return eventsToPreferenceGroups(events, features).filter(group => group.profileId === profileId);
}
function persistedGroups(groups) {
  return groups.map(group => { const copy = { ...group }; delete copy.presentationOrder; delete copy.hideAI; return copy; });
}
export async function applyPreferenceSnapshot(data, decisions, profile, hashes, features) {
  if (!profile.config.enabled || !profile.report?.ready || !profile.head) {
    return { changedGroups: 0, ready: false, reason: 'disabled-or-unvalidated', data };
  }
  const reviewed = new Set(decisions.filter(row => row.source === 'human').map(row => row.unitId));
  const resultMap = new Map(data.results.map(row => [row.unitId, row]));
  let changedGroups = 0;
  const groups = [];
  for (const group of persistedGroups(data.groups)) {
    if (group.unitIds.length < 2 || group.unitIds.some(id => reviewed.has(id))) { groups.push(group); continue; }
    const rows = [];
    for (const entry of group.ranking || []) {
      const feature = features.get(hashes.get(entry.unitId));
      const score = feature && preferenceScore(feature, profile.head);
      if (!Number.isFinite(score)) break;
      rows.push({ ...entry, l0Score: entry.l0Score ?? entry.score, l0Rank: entry.l0Rank ?? entry.rank,
        score: entry.l0Score ?? entry.score, preferenceScore: score,
        reasons: [...(entry.reasons || []).filter(reason => !reason.startsWith('L1 偏好')), 'L1 偏好排序（已通过时间留出评估）'] });
    }
    if (rows.length !== group.unitIds.length) { groups.push(group); continue; }
    // The L1 head can only compare inside existing L0 gate strata. Relative-eye
    // protections are preserved too; subjective fitting cannot override safety.
    const tier = entry => (entry.reasons?.includes('硬伤门槛：排在通过者之后') ? 2 : 0)
      + (entry.reasons?.includes('同组睁眼帧优先') ? -1 : 0);
    rows.sort((a, b) => tier(a) - tier(b) || b.preferenceScore - a.preferenceScore || a.unitId.localeCompare(b.unitId));
    const ranking = rows.map((row, index) => ({ ...row, rank: index + 1 }));
    const suggested = Object.fromEntries(ranking.map(row => [row.unitId,
      suggestDecision(row, resultMap.get(row.unitId) || {}, group.unitIds.length)]));
    const updated = { ...group, ranking, suggested, l0Suggested: group.l0Suggested || group.suggested,
      l0Ranking: group.l0Ranking || group.ranking,
      l0ReviewMetadata: group.l0ReviewMetadata || Object.fromEntries(['confidence', 'margin']
        .filter(key => Object.hasOwn(group, key)).map(key => [key, group[key]])),
      preferenceSnapshot: profile.head.snapshotId,
      confidence: "low", margin: null };
    if (JSON.stringify(updated) !== JSON.stringify(group)) changedGroups += 1;
    groups.push(updated);
  }
  return { changedGroups, ready: true, data: { ...data, groups } };
}
export function restorePreferenceOrder(data, decisions, keepSnapshot = null) {
  const reviewed = new Set(decisions.filter(row => row.source === 'human').map(row => row.unitId));
  let changedGroups = 0;
  const groups = data.groups.map(group => {
    if (!group.preferenceSnapshot || group.preferenceSnapshot === keepSnapshot || group.unitIds.some(id => reviewed.has(id))) return group;
    const ranking = group.l0Ranking || group.ranking.map(row => ({ ...row, rank: row.l0Rank ?? row.rank, score: row.l0Score ?? row.score,
      reasons: (row.reasons || []).filter(reason => !reason.startsWith('L1 偏好')) })).sort((a, b) => a.rank - b.rank);
    const copy = { ...group, ranking, suggested: group.l0Suggested || group.suggested };
    if (group.l0ReviewMetadata) {
      delete copy.confidence; delete copy.margin;
      Object.assign(copy, group.l0ReviewMetadata);
    }
    delete copy.l0Suggested; delete copy.l0Ranking; delete copy.l0ReviewMetadata;
    delete copy.preferenceSnapshot; changedGroups++;
    return copy;
  });
  return { changedGroups, data: { ...data, groups } };
}
export async function handleLearningRoute(req, res, ctx, data) {
  const url = new URL(req.url, 'http://localhost');
  const base = `/runs/${data.run.id}/learning`;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  const { dataStore, profiles } = learningServices(ctx);
  const body = req.method === 'POST' ? await ctx.readBody(req) : {};
  const profileId = body.profileId || url.searchParams.get('profileId') || 'default';
  const profile = await profiles.loadProfile(profileId);
  const status = async () => {
    const current = await profiles.loadProfile(profileId);
    const groups = await learningGroups(dataStore, profileId);
    return { ...current, profileId, profiles: await profiles.listProfiles(),
      drift: current.head ? driftReport(groups, current.head, { recentGroups: current.config.recentGroups,
        threshold: current.config.driftThreshold }) : { reason: 'insufficient-data' } };
  };
  if (req.method === 'GET' && url.pathname === base) { ctx.json(res, 200, await status()); return true; }
  const action = url.pathname.slice(base.length + 1);
  if (req.method !== 'POST') return false;
  if (action === 'config') {
    await profiles.saveConfig(profileId, body.config || {});
    if (body.config?.enabled === false) {
      const { DecisionsStore } = await import('../core/decisions-store.js');
      const decisions = await new DecisionsStore(ctx.runStore.dir(data.run.id)).read();
      const restored = restorePreferenceOrder(data, decisions);
      if (restored.changedGroups) await ctx.runStore.save(data.run, restored.data);
    }
    ctx.json(res, 200, await status());
  } else if (action === 'select') {
    const { DecisionsStore } = await import('../core/decisions-store.js');
    const decisions = await new DecisionsStore(ctx.runStore.dir(data.run.id)).read();
    const restored = restorePreferenceOrder(data, decisions, profile.config.enabled ? profile.head?.snapshotId : null);
    if (restored.changedGroups) await ctx.runStore.save(data.run, restored.data);
    ctx.json(res, 200, await status());
  } else if (action === 'exposure') {
    const event = await dataStore.recordExposure(data, body.groupId, { ...body,
      timestamp: ctx.clock?.().toISOString(),
      unitIds: body.order, visibleUnitIds: body.viewport, displayProbability: body.allocationProbability,
      modelVersion: profile.head?.version || 'L0', weightsVersion: profile.head?.snapshotId || 'L0' });
    ctx.json(res, 200, { eventId: event.id });
  } else if (action === 'backfill') {
    const { DecisionsStore } = await import('../core/decisions-store.js');
    const events = await dataStore.backfill(data, await new DecisionsStore(ctx.runStore.dir(data.run.id)).read(), { profileId });
    ctx.json(res, 200, { events: events.length, exposureKnown: false });
  } else if (action === 'train') {
    await profiles.train(profileId, await learningGroups(dataStore, profileId));
    ctx.json(res, 200, await status());
  } else if (action === 'rollback') {
    await profiles.rollback(profileId, body.version);
    ctx.json(res, 200, await status());
  } else if (action === 'scan-deletions') {
    if (data.run.libraryPath !== PROTECTED_LEARNING_LIBRARY) throw new Error('Deletion scan requires protected library');
    const active = await ctx.api.assertLibrary(PROTECTED_LEARNING_LIBRARY);
    const liveItemIds = [];
    for await (const item of ctx.api.items()) if (!item.isDeleted && !item.deleted) liveItemIds.push(item.id);
    // Reassert after inventory: a library switch must not turn all features negative.
    await ctx.api.assertLibrary(PROTECTED_LEARNING_LIBRARY);
    const events = await dataStore.detectDeletions({ libraryPath: data.run.libraryPath,
      activeLibraryPath: active.path, liveItemIds, complete: true, profileId,
      timestamp: ctx.clock?.().toISOString() });
    ctx.json(res, 200, { tombstones: events.length });
  } else if (action === 'apply') {
    if (!profile.config.enabled || !profile.report?.ready || !profile.head) {
      ctx.json(res, 409, { changedGroups: 0, ready: false, reason: 'disabled-or-unvalidated' });
      return true;
    }
    const { DecisionsStore } = await import('../core/decisions-store.js');
    const decisions = await new DecisionsStore(ctx.runStore.dir(data.run.id)).read();
    const hashes = await dataStore.ingestRun(data);
    const features = new Map();
    for (const hash of hashes.values()) features.set(hash, await dataStore.features.get(hash));
    const { data: updated, ...report } = await applyPreferenceSnapshot(data, decisions, profile, hashes, features);
    if (report.changedGroups) await ctx.runStore.save(data.run, updated);
    ctx.json(res, report.ready ? 200 : 409, report);
  } else return false;
  return true;
}
