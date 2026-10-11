import { localSetting } from './local-config.js';
import { RANKING_WEIGHTS_META } from "./ranking.js";
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { FeatureStore, atomicJson } from './feature-store.js';
import { EventLog } from './event-log.js';
import { PixelRetention } from './pixel-retention.js';

export const PROTECTED_LEARNING_LIBRARY = localSetting('EAGLE_LEARNING_LIBRARY', '/unconfigured/expected.library');
const groupIndexPending = new Map();

export class LearningData {
  constructor(root = 'data/learning') {
    this.root = root; this.features = new FeatureStore(root); this.events = new EventLog(root);
    this.pixels = new PixelRetention(root); this.queue = Promise.resolve(); this.runHashes = new Map(); this.ingested = new WeakMap();
  }
  async ingestRun(data) {
    const signature = JSON.stringify([data.run?.id, data.run?.libraryPath, data.groups || [],
      (data.items || []).map(item => [item.id, item.filePath || item.path, item.size, item.mtimeMs]),
      (data.units || []).map(unit => [unit.id, unit.primaryItemId, unit.itemIds]),
      (data.results || []).map(result => [result.unitId, result.fingerprint])]);
    const cached = this.ingested.get(data.results);
    if (cached?.signature === signature) return cached.hashes;
    const unitGroups = new Map((data.groups || []).flatMap(group => group.unitIds.map(id => [id, group])));
    const units = new Map((data.units || []).map(unit => [unit.id, unit]));
    const items = new Map((data.items || []).map(item => [item.id, item]));
    const hashes = new Map();
    const runKey = createHash('sha256').update(String(data.run?.id || 'legacy')).digest('hex');
    const indexFile = path.join(this.root, 'run-index', 'v1', `${runKey}.json`);
    let cache = this.runHashes.get(data.run?.id);
    if (!cache) {
      try { cache = new Map(Object.entries(JSON.parse(await readFile(indexFile, 'utf8')))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; cache = new Map(); }
      this.runHashes.set(data.run?.id, cache);
    }
    let changed = false;
    for (const result of data.results || []) {
      const unit = units.get(result.unitId) || {};
      const item = items.get(unit.primaryItemId || unit.itemIds?.[0]) || {};
      const group = unitGroups.get(result.unitId) || {};
      const cacheKey = JSON.stringify([result.unitId, result.fingerprint, item.filePath || item.path, item.size, item.mtimeMs, group.id]);
      let hash = cache.get(cacheKey);
      if (!hash) {
        const feature = await this.features.fromResult(result, { unit, item, group, run: data.run || {} });
        if (feature) { hash = feature.hash; cache.set(cacheKey, hash); changed = true; }
      }
      if (hash) hashes.set(result.unitId, hash);
    }
    if (changed) await atomicJson(indexFile, Object.fromEntries(cache));
    const groupsFile = path.join(this.root, 'run-index', 'v1', `${runKey}-groups.json`);
    const groupRows = (data.groups || []).map(group => ({ id: group.id,
      candidateHashes: group.unitIds.map(id => hashes.get(id) || null),
      ai: { ranking: (group.ranking || []).map(row => ({ ...row, hash: hashes.get(row.unitId) || null })),
        suggested: group.suggested } }));
    const update = (groupIndexPending.get(groupsFile) || Promise.resolve()).then(async () => {
      let rows = groupRows;
      if (data.partial) {
        let previous = [];
        try { previous = JSON.parse(await readFile(groupsFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const merged = new Map(previous.map(group => [group.id, group]));
        for (const group of groupRows) merged.set(group.id, group);
        rows = [...merged.values()];
      }
      await atomicJson(groupsFile, rows);
    });
    const pending = update.catch(() => {});
    groupIndexPending.set(groupsFile, pending);
    try { await update; }
    finally { if (groupIndexPending.get(groupsFile) === pending) groupIndexPending.delete(groupsFile); }
    if (Array.isArray(data.results)) this.ingested.set(data.results, { signature, hashes });
    return hashes;
  }
  recordDecisions(data, decisions, context = {}) {
    const operation = this.queue.then(() => this._recordDecisions(data, decisions, context));
    this.queue = operation.catch(() => {}); return operation;
  }
  async _recordDecisions(data, decisions, context) {
    const hashes = await this.ingestRun(data);
    const history = await this.events.read();
    const latest = new Map();
    for (const event of history) {
      if (['decision', 'undo'].includes(event.type) && event.runId === data.run?.id &&
        event.profileId === (context.profileId || 'default')) latest.set(event.groupId, event);
    }
    const rows = [];
    for (const group of data.groups || []) {
      if (context.changedUnitIds && !group.unitIds.some(id => context.changedUnitIds.includes(id))) continue;
      const groupDecisions = decisions.filter(decision => group.unitIds.includes(decision.unitId) && decision.source !== 'suggested');
      const snapshot = groupDecisions.map(decision => ({ unitId: decision.unitId, hash: hashes.get(decision.unitId) || null,
        action: decision.action, tie: decision.tie === true, category: decision.category || null,
        reason: decision.reason || null, updatedAt: decision.updatedAt || null }));
      const previous = latest.get(group.id);
      if (JSON.stringify(previous?.decisions || []) === JSON.stringify(snapshot)) continue;
      const ai = { suggested: Object.fromEntries(group.unitIds.map(id => [hashes.get(id) || id,
        group.suggested?.[id] || 'candidate'])),
        l0Suggested: group.l0Suggested || group.suggested,
        ranking: (group.ranking || []).map(row => ({ ...row, hash: hashes.get(row.unitId) || null })) };
      const corrected = groupDecisions.some(decision => group.suggested?.[decision.unitId] &&
        group.suggested[decision.unitId] !== decision.action);
      const bulk = context.signal === 'bulk' || context.operation === 'bulk';
      const exposure = history.filter(event => event.type === 'exposure' && event.runId === data.run?.id &&
        event.groupId === group.id && event.profileId === (context.profileId || 'default')).at(-1);
      const tied = snapshot.filter(row => row.tie && row.action === 'candidate');
      const undo = context.undo === true || context.operation === 'undo' || !snapshot.length;
      const event = await this.events.append({ type: undo ? 'undo' : 'decision', action: undo ? 'undo' : 'review',
        timestamp: context.timestamp || (context.backfill ? groupDecisions.map(row => row.updatedAt).filter(Boolean).sort().at(-1) : null),
        runId: data.run?.id, groupId: group.id, profileId: context.profileId || 'default',
        libraryPath: data.run?.libraryPath || null, candidateHashes: group.unitIds.map(id => hashes.get(id) || null),
        decisions: snapshot, winners: snapshot.filter(row => row.action === 'selected' || tied.length > 1 && row.tie)
          .map(row => row.hash).filter(Boolean),
        tie: snapshot.some(row => row.tie), category: context.category || snapshot.find(row => row.category)?.category || null,
        reason: context.reason || snapshot.find(row => row.reason)?.reason || null,
        signal: bulk ? 'bulk' : corrected ? 'corrected' : 'explicit', ai,
        provenance: context.backfill ? 'historical-decisions' : 'review', exposureKnown: Boolean(exposure),
        exposureEventId: exposure?.id || null,
        durationMs: context.durationMs ?? (exposure ? Math.max(0,
          (context.timestamp ? Date.parse(context.timestamp) : Date.now()) - Date.parse(exposure.timestamp)) : null),
        modelVersion: group.preferenceSnapshot ? context.modelVersion || 'L1' : data.run?.modelVersion || 'L0',
        weightsVersion: group.preferenceSnapshot || RANKING_WEIGHTS_META.version,
        featureModels: (data.results || []).filter(result => group.unitIds.includes(result.unitId))
          .map(result => ({ unitId: result.unitId, scorer: result.scorer || 'na', fingerprint: result.fingerprint || 'na' })),
        targetEventId: previous?.id || null, clientVersion: context.clientVersion || null });
      rows.push(event);
    }
    return rows;
  }
  async recordExposure(data, groupId, context = {}) {
    const group = data.groups?.find(row => row.id === groupId);
    if (!group) throw new Error('Unknown exposure group');
    const hashes = await this.ingestRun(data);
    const order = context.unitIds || group.ranking?.map(row => row.unitId) || group.unitIds;
    if (order.some(id => !group.unitIds.includes(id))) throw new Error('Exposure contains non-member');
    return this.events.append({ type: 'exposure', runId: data.run?.id, groupId, profileId: context.profileId || 'default',
      timestamp: context.timestamp,
      candidateHashes: group.unitIds.map(id => hashes.get(id) || null),
      display: order.map((id, index) => ({ unitId: id, hash: hashes.get(id) || null, rank: index + 1,
        inViewport: context.visibleUnitIds ? context.visibleUnitIds.includes(id) : null })),
      aiVisible: context.aiVisible !== false, ai: { suggested: group.suggested,
        ranking: (group.ranking || []).map(row => ({ ...row, hash: hashes.get(row.unitId) || null })) },
      queryPolicy: context.queryPolicy || 'normal', displayProbability: context.displayProbability ?? null,
      durationMs: context.durationMs ?? null, modelVersion: context.modelVersion || 'L0',
      weightsVersion: group.preferenceSnapshot || RANKING_WEIGHTS_META.version });
  }
  async backfill(data, decisions, context = {}) { return this.recordDecisions(data, decisions, { ...context, backfill: true }); }
  detectDeletions(inventory) {
    const operation = this.queue.then(() => this._detectDeletions(inventory));
    this.queue = operation.catch(() => {}); return operation;
  }
  async _detectDeletions({ libraryPath, activeLibraryPath, liveItemIds, complete = false, profileId = 'default', timestamp }) {
    if (!complete || libraryPath !== PROTECTED_LEARNING_LIBRARY || activeLibraryPath !== libraryPath || !Array.isArray(liveItemIds)) {
      throw new Error('Deletion detection requires complete inventory and verified protected active library');
    }
    const live = new Set(liveItemIds), history = await this.events.read(), deleted = [];
    const tombstones = new Set(history.filter(event => event.type === 'tombstone')
      .map(event => JSON.stringify([event.hash, event.runId, event.groupId])));
    let prefixes;
    try { prefixes = await readdir(this.features.dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    for (const prefix of prefixes) {
      for (const file of await readdir(path.join(this.features.dir, prefix))) {
        if (!file.endsWith('.json')) continue;
        const feature = JSON.parse(await readFile(path.join(this.features.dir, prefix, file), 'utf8'));
        const contexts = feature.contexts.filter(row => row.libraryPath === libraryPath && row.itemIds?.length);
        for (const context of contexts) {
          if (context.itemIds.some(id => live.has(id))) continue;
          const key = JSON.stringify([feature.hash, context.runId, context.groupId]);
          if (tombstones.has(key)) continue;
          const runKey = createHash('sha256').update(String(context.runId || 'legacy')).digest('hex');
          let groupContext;
          try {
            const groups = JSON.parse(await readFile(path.join(this.root, 'run-index', 'v1', `${runKey}-groups.json`), 'utf8'));
            groupContext = groups.find(group => group.id === context.groupId);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const event = await this.events.append({ candidateHashes: groupContext?.candidateHashes, ai: groupContext?.ai,
            timestamp,
            type: 'tombstone', action: 'rejected', signal: 'deleted',
            hash: feature.hash, profileId, libraryPath, runId: context.runId, groupId: context.groupId,
            itemIds: context.itemIds, evidence: 'complete-read-only-inventory', strength: 'strong-negative',
            retention: feature.retention || { tier: 0 }, modelVersion: 'L0',
            weightsVersion: RANKING_WEIGHTS_META.version });
          deleted.push(event); tombstones.add(key);
        }
        if (contexts.length && contexts.every(context => context.itemIds.every(id => !live.has(id)))) {
          await this.features.put({ ...feature, availability: { original: false, observedAt: new Date().toISOString() } });
        }
      }
    }
    return deleted;
  }
  async retainPixels(hash, options) {
    const feature = await this.features.get(hash);
    if (!feature) throw new Error('Unknown feature hash');
    const retention = await this.pixels.retain(hash, { faces: feature.faces.items, ...options });
    await this.features.put({ ...feature, retention }); return retention;
  }
}
