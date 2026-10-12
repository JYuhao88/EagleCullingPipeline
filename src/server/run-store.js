import { replaceFile } from '../core/atomic-file.js';
import { groupConfidence } from "../core/ranking.js";
import { DecisionsStore } from "../core/decisions-store.js";
import { writeSegmented, readManifest, readRow, readRows } from "../core/segmented-results.js";
import { LearningData } from "../core/learning-data.js";
import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { applyGroupOverrides } from "../core/group-overrides.js";

const newestFirst = (a, b) => (Date.parse(b.startedAt || b.createdAt) || 0) -
  (Date.parse(a.startedAt || a.createdAt) || 0) || b.id.localeCompare(a.id);

export class RunStore {
  constructor(root = "data/runs") {
    this.root = path.resolve(root);
    this.pending = new Map();
    this.analysisGeneration = 0;
    this.knownAnalysisRuns = new Set();
    this.overridePending = new Map();
    this.unitIndexes = new Map();
    this.resultSnapshots = new Map();
    this.manifests = new Map();
    this.learningData = new LearningData(path.join(path.dirname(this.root), "learning"));
  }

  dir(id) {
    return path.join(this.root, id);
  }

  directory(id) {
    return this.dir(id);
  }

  async save(run, data = {}, { metadataOnly = false } = {}) {
    // Snapshot at enqueue time: later progress must not change queued writes.
    const runJson = { ...run };
    delete runJson.controller;
    delete runJson.results;
    delete runJson.groups;
    delete runJson.units;
    delete runJson.items;
    delete runJson.duplicateCandidates;
    const state = data.run ? data : { ...data, ...(run.results || {}), run };
    const previous = this.pending.get(run.id) || Promise.resolve();
    const operation = previous.then(async () => {
      const directory = this.dir(run.id);
      await mkdir(directory, { recursive: true });
      const resultData = {
        run: runJson,
        units: state.units || [],
        results: state.results || [],
        groups: state.groups || [],
        items: state.items || [],
        ...(state.duplicateCandidates ? { duplicateCandidates: state.duplicateCandidates } : {}),
      };
      if (!metadataOnly && (state.results || state.units || state.groups || state.items)) {
        await writeSegmented(directory, resultData);
        await this.saveReviewSummary(run.id, resultData.groups);
        if (run.status === "completed" && run.purpose !== "prefetch") {
          try { await this.learningData.ingestRun(resultData); }
          catch (error) { runJson.learningWarning = error.message; }
        }
      }
      if (!metadataOnly && state.applied) {
        await writeFile(path.join(directory, "applied.json"), JSON.stringify(state.applied, null, 2));
      }
      // Publish terminal status only after its result payload is durable.
      await this.writeAtomic(run.id, "run.json", runJson);
      if (!this.knownAnalysisRuns.has(run.id) || !metadataOnly) {
        this.knownAnalysisRuns.add(run.id); this.analysisGeneration++;
      }
      return run;
    });
    const queued = operation.catch(() => {});
    this.pending.set(run.id, queued);
    try {
      return await operation;
    } finally {
      if (this.pending.get(run.id) === queued) this.pending.delete(run.id);
    }
  }

  async saveProgress(run) {
    return this.save(run, {}, { metadataOnly: true });
  }

  async getRun(id) {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), "run.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async datedRun(id) {
    const run = await this.getRun(id);
    if (!run || run.startedAt || run.createdAt) return run;
    try { return { ...run, startedAt: (await stat(path.join(this.dir(id), "run.json"))).mtime.toISOString() }; }
    catch { return run; }
  }

  async recentRuns(limit = 10) {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const run = await this.datedRun(entry.name);
      if (run && run.purpose !== 'prefetch') runs.push(run);
    }
    return runs.sort(newestFirst).slice(0, limit);
  }

  async allRuns() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const run = await this.getRun(entry.name).catch(() => null);
      if (run) runs.push(run);
    }
    return runs;
  }

  async analyzedItemIds(itemIds, libraryPath) {
    const wanted = new Set(itemIds), analyzed = new Set();
    for (const run of await this.allRuns()) {
      if (run.libraryPath !== libraryPath || run.status !== 'completed') continue;
      const manifest = await this.manifest(run.id);
      if (manifest) {
        const completed = new Set();
        for await (const result of readRows(this.dir(run.id), manifest, 'results')) completed.add(result.unitId);
        for await (const unit of readRows(this.dir(run.id), manifest, 'units')) {
          if (!completed.has(unit.id)) continue;
          for (const id of unit.itemIds || [unit.primaryItemId]) if (wanted.has(id)) analyzed.add(id);
        }
      } else {
        const data = await this.results(run.id, { readOnly: true });
        const completed = new Set((data?.results || []).map(row => row.unitId));
        for (const unit of data?.units || []) if (completed.has(unit.id)) {
          for (const id of unit.itemIds || [unit.primaryItemId]) if (wanted.has(id)) analyzed.add(id);
        }
      }
      if (analyzed.size === wanted.size) break;
    }
    return [...analyzed];
  }

  async cacheProtection() {
    const files = [], fingerprints = [];
    for (const run of await this.allRuns()) {
      if (!['running', 'queued'].includes(run.status)) continue;
      const data = await this.results(run.id, { readOnly: true });
      for (const row of data?.results || []) {
        if (row.previewPath) files.push(row.previewPath, `${row.previewPath}.json`);
        if (row.fingerprint) fingerprints.push(row.fingerprint);
      }
    }
    return { files, fingerprints };
  }

  async prefetchRuns() {
    return (await this.allRuns()).filter(run => run.purpose === 'prefetch').sort(newestFirst);
  }

  async latestPrefetch() {
    return (await this.prefetchRuns()).find(run => run.status !== 'running') || null;
  }

  async prunePrefetchRuns(keep = 5) {
    for (const run of (await this.prefetchRuns()).filter(run => run.status !== 'running').slice(keep)) {
      if (/^run-[a-zA-Z0-9_-]+$/.test(run.id)) await rm(this.dir(run.id), { recursive: true, force: true });
    }
  }

  async saveReviewSummary(id, groups) {
    await this.writeAtomic(id, 'review-summary.json', groups.map(group => ({ id: group.id, unitIds: group.unitIds })));
  }

  async reviewSummary(id) {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'review-summary.json'), 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Legacy runs may have a lightweight manifest but no dedicated summary yet.
    // Never materialize results or rerank corrected groups for the home page.
    if ((await this.groupOverrides(id)).operations.length) return null;
    return (await this.manifest(id))?.groups || null;
  }

  async list({ limit = 20, cursor = 0, libraryPath } = {}) {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      try {
        const run = await this.datedRun(entry.name);
        if (run && run.purpose !== 'prefetch' && run.id === entry.name && (!libraryPath || run.libraryPath === libraryPath)) runs.push(run);
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    runs.sort(newestFirst);
    const summaries = [];
    for (const run of runs.slice(cursor, cursor + limit)) {
      const groups = await this.reviewSummary(run.id);
      const reviewed = new Set((await new DecisionsStore(this.dir(run.id)).read())
        .filter(row => row.source === 'human').map(row => row.unitId));
      summaries.push({ id: run.id, status: run.status, startedAt: run.startedAt ||
        run.createdAt || null,
        itemCount: run.itemCount || run.progress?.summary?.itemCount || 0,
        unitCount: run.unitCount || run.progress?.summary?.unitCount || 0,
        groupCount: groups?.length ?? run.groupCount ?? run.progress?.summary?.groupCount ?? 0,
        reviewedGroupCount: groups ? groups.filter(group => group.unitIds.length &&
          group.unitIds.every(id => reviewed.has(id))).length : null,
        selectedCount: run.selectedCount ?? null, rejectedCount: run.rejectedCount ?? null,
        scope: run.scope || { type: 'unknown', label: '以前的分析' }, error: run.error || null,
        progress: run.progress || null });
    }
    return { runs: summaries, page: { total: runs.length, cursor, limit,
      nextCursor: cursor + limit < runs.length ? String(cursor + limit) : null } };
  }

  async get(id, { readOnly = false } = {}) {
    try {
      const run = JSON.parse(
        await readFile(path.join(this.dir(id), "run.json"), "utf8"),
      );
      const results = await this.results(id, { readOnly });
      const overrides = await this.groupOverrides(id);
      const groups = applyGroupOverrides(results?.groups || [], results?.results || [], overrides.operations);
      return {
        run: { ...run, groupCount: groups.length },
        units: results?.units || [],
        results: results?.results || [],
        groups,
        groupOverrides: overrides,
        items: results?.items || [],
        ...(results?.duplicateCandidates ? { duplicateCandidates: results.duplicateCandidates } : {}),
        applied: await this.applied(id),
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async results(id, { readOnly = false } = {}) {
    const manifest = await this.manifest(id);
    if (manifest) {
      const load = async () => {
        const data = {};
        for (const kind of ["units", "results", "groups", "items"]) {
          data[kind] = [];
          for await (const row of readRows(this.dir(id), manifest, kind)) data[kind].push(row);
        }
        try { data.duplicateCandidates = JSON.parse(await readFile(
          path.join(this.dir(id), manifest.generation, "duplicates.json"), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        return data;
      };
      const bytes = Object.values(manifest.indexes).reduce((sum, index) =>
        sum + Object.values(index).reduce((total, location) => total + location[2], 0), 0);
      if (bytes > 64 * 1024 ** 2) return load();
      let entry = this.resultSnapshots.get(id);
      if (entry?.signature !== manifest.generation) {
        entry = { signature: manifest.generation, promise: load() };
        this.resultSnapshots.set(id, entry);
        while (this.resultSnapshots.size > 2) this.resultSnapshots.delete(this.resultSnapshots.keys().next().value);
      }
      const data = await entry.promise;
      return readOnly ? data : structuredClone(data);
    }
    const file = path.join(this.dir(id), "results.json");
    try {
      const metadata = await stat(file);
      const signature = [metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
      let entry = this.resultSnapshots.get(id);
      if (entry?.signature !== signature) {
        entry = { signature, promise: readFile(file, "utf8").then(JSON.parse) };
        this.resultSnapshots.set(id, entry);
        while (this.resultSnapshots.size > 2) this.resultSnapshots.delete(this.resultSnapshots.keys().next().value);
      }
      const value = await entry.promise;
      // Only internal read-only consumers share the immutable analysis arrays.
      return readOnly ? value : structuredClone(value);
    } catch (error) {
      this.resultSnapshots.delete(id);
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // Images need one unit, not a fresh parse of every embedding in a large run.
  // Atomic result replacement invalidates the index; callers receive detached data.
  async unitData(id, unitId) {
    const run = await this.getRun(id);
    if (!run) return null;
    const manifest = await this.manifest(id);
    if (manifest) {
      const unit = await readRow(this.dir(id), manifest, 'units', unitId);
      const result = await readRow(this.dir(id), manifest, 'results', unitId);
      const groups = (await this.groupIndex(id, manifest)).filter(group => group.unitIds.includes(unitId));
      const fullGroups = [];
      for (const group of groups) fullGroups.push(await this.loadGroup(id, manifest, group));
      const items = [];
      for (const itemId of unit?.itemIds || [unit?.primaryItemId]) {
        const item = await readRow(this.dir(id), manifest, 'items', itemId);
        if (item) items.push(item);
      }
      return { run, units: unit ? [unit] : [], results: result ? [result] : [], items,
        groups: fullGroups, analysisSignature: manifest.analysisSignature };
    }
    const file = path.join(this.dir(id), "results.json");
    let metadata;
    try { metadata = await stat(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const signature = [metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
    let entry = this.unitIndexes.get(id);
    if (entry?.signature !== signature) {
      entry = { signature, promise: this.results(id, { readOnly: true }).then(data => ({
        groups: data?.groups || [],
        analysisSignature: createHash("sha256")
          .update(JSON.stringify((data?.results || []).map(row => [row.unitId, row.fingerprint || null]))).digest("hex"),
        units: new Map((data?.units || []).map(row => [row.id, row])),
        results: new Map((data?.results || []).map(row => [row.unitId, row])),
        items: new Map((data?.items || []).map(row => [row.id, row]))
      })) };
      this.unitIndexes.set(id, entry);
      // Bound retained run indexes, including when reviewing multiple projects.
      while (this.unitIndexes.size > 2) this.unitIndexes.delete(this.unitIndexes.keys().next().value);
    }
    let index;
    try { index = await entry.promise; }
    catch (error) { if (this.unitIndexes.get(id) === entry) this.unitIndexes.delete(id); throw error; }
    const unit = index.units.get(unitId), result = index.results.get(unitId);
    const overrides = await this.groupOverrides(id);
    const groups = applyGroupOverrides(index.groups, [...index.results.values()], overrides.operations);
    return structuredClone({ run, units: unit ? [unit] : [], results: result ? [result] : [],
      groups: groups.filter(group => group.unitIds.includes(unitId)), analysisSignature: index.analysisSignature,
      items: (unit?.itemIds || [unit?.primaryItemId]).map(itemId => index.items.get(itemId)).filter(Boolean) });
  }

  async selection(id, unitIds) {
    const pages = [];
    const seen = new Set();
    for (const unitId of unitIds) {
      const single = await this.unitData(id, unitId);
      for (const group of single?.groups || []) {
        if (seen.has(group.id)) continue;
        seen.add(group.id);
        pages.push(await this.page(id, { groupId: group.id }));
      }
    }
    const run = await this.getRun(id);
    if (!run) return null;
    return { run, partial: true, ...Object.fromEntries(['units', 'results', 'items', 'groups'].map(kind =>
      [kind, pages.flatMap(page => page[kind])])) };
  }

  async manifest(id) {
    const file = path.join(this.dir(id), 'results-index.json');
    try {
      const metadata = await stat(file);
      const signature = [metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':');
      let entry = this.manifests.get(id);
      if (entry?.signature !== signature) {
        entry = { signature, promise: readManifest(this.dir(id)) };
        this.manifests.set(id, entry);
        while (this.manifests.size > 2) this.manifests.delete(this.manifests.keys().next().value);
      }
      return await entry.promise;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async groupIndex(id, manifest) {
    const overrides = await this.groupOverrides(id);
    if (!overrides.operations.length) return manifest.groups;
    // Load only units touched by corrections; unaffected groups stay summaries.
    let groups = manifest.groups;
    const results = new Map();
    for (const operation of overrides.operations) {
      const affected = groups.filter(group => group.unitIds.includes(operation.unitId) ||
        group.id === operation.targetGroupId || group.id === operation.groupId || operation.groupIds?.includes(group.id));
      for (const unitId of affected.flatMap(group => group.unitIds)) {
        if (!results.has(unitId)) results.set(unitId, await readRow(this.dir(id), manifest, 'results', unitId));
      }
      groups = applyGroupOverrides(groups, [...results.values()], [operation]).map(group =>
        group.ranking ? { ...group, ...groupConfidence(group, results),
          flags: [...new Set(group.unitIds.flatMap(key => results.get(key)?.flags || []))] } : group);
    }
    return groups;
  }

  async loadGroup(id, manifest, group) {
    return group.ranking ? group : await readRow(this.dir(id), manifest, 'groups', group.id);
  }

  async page(id, { limit = 40, cursor = 0, filter = 'all', groupId, unitId, summariesOnly = false } = {}) {
    const run = await this.getRun(id);
    if (!run) return null;
    const manifest = await this.manifest(id);
    let base, groups;
    if (manifest) groups = await this.groupIndex(id, manifest);
    else {
      base = await this.get(id, { readOnly: true });
      const byId = new Map(base.results.map(row => [row.unitId || row.id, row]));
      groups = base.groups.map(group => ({ ...group, ...groupConfidence(group, byId),
        flags: [...new Set(group.unitIds.flatMap(key => byId.get(key)?.flags || []))] }));
    }
    const reviewed = new Set(['reviewed', 'unreviewed'].includes(filter)
      ? (await new DecisionsStore(this.dir(id)).read()).filter(row => row.source === 'human').map(row => row.unitId) : []);
    groups = groups.filter(group => (!groupId || group.id === groupId) &&
      (!unitId || group.unitIds.includes(unitId)) &&
      (!['multi', 'low-first'].includes(filter) || group.unitIds.length > 1) &&
      (filter !== 'confirm' || group.confidence === 'low') &&
      (filter !== 'singles' || group.unitIds.length === 1) &&
      (filter !== 'reviewed' || group.unitIds.every(key => reviewed.has(key))) &&
      (filter !== 'unreviewed' || group.unitIds.some(key => !reviewed.has(key))) &&
      (filter !== 'issues' || group.flags?.length > 0) &&
      (filter !== 'eyes-closed' || group.flags?.includes('eyes-closed')) &&
      (filter !== 'blurry' || group.flags?.some(flag => ['blurry', 'possibly-blurry'].includes(flag))));
    if (filter === 'low-first') groups.sort((a, b) => Number(b.confidence === 'low') - Number(a.confidence === 'low'));
    const selected = groups.slice(cursor, cursor + limit);
    const data = { run, partial: true, units: [], results: [], items: [], groups: [],
      page: { total: groups.length, cursor, limit, nextCursor: cursor + limit < groups.length ? String(cursor + limit) : null },
      groupOverrides: await this.groupOverrides(id), writebackAvailable: Boolean((await this.applied(id)).length) };
    if (summariesOnly) {
      data.groups = selected.map(group => ({ id: group.id, unitIds: group.unitIds, size: group.unitIds.length,
        confidence: group.confidence, margin: group.margin, flags: group.flags || [], previewUnitId: group.unitIds[0] }));
      return data;
    }
    const seenItems = new Set();
    for (const group of selected) {
      data.groups.push(manifest ? await this.loadGroup(id, manifest, group) : group);
      for (const key of group.unitIds) {
        if (unitId && key !== unitId) continue;
        const unit = manifest ? await readRow(this.dir(id), manifest, 'units', key) : base.units.find(row => row.id === key);
        const result = manifest ? await readRow(this.dir(id), manifest, 'results', key) : base.results.find(row => row.unitId === key);
        if (unit) data.units.push(unit);
        if (result) data.results.push(result);
        for (const itemId of unit?.itemIds || [unit?.primaryItemId]) {
          if (seenItems.has(itemId)) continue;
          seenItems.add(itemId);
          const item = manifest ? await readRow(this.dir(id), manifest, 'items', itemId) : base.items.find(row => row.id === itemId);
          if (item) data.items.push(item);
        }
      }
    }
    return data;
  }

  async applied(id) {
    try {
      const value = JSON.parse(await readFile(path.join(this.dir(id), "applied.json"), "utf8"));
      return Array.isArray(value) ? value : value.items || [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async saveApplied(id, records) {
    await this.writeAtomic(id, "applied.json", records);
  }

  async writeAtomic(id, filename, value) {
    const directory = this.dir(id);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, filename);
    const temporary = `${file}.${randomUUID()}.tmp`;
    // Large result arrays contain embeddings/geometry; whitespace doubles IO
    // without changing the JSON contract. Small human-edited metadata stays pretty.
    await writeFile(temporary, JSON.stringify(value, null, filename === "results.json" ? 0 : 2), "utf8");
    await replaceFile(temporary, file);
  }

  async groupOverrides(id) {
    try {
      const value = JSON.parse(await readFile(path.join(this.dir(id), "group-overrides.json"), "utf8"));
      if (!Array.isArray(value.operations)) throw new Error("分组修正记录格式无效");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { contractVersion: 1, operations: [] };
      throw error;
    }
  }

  async mutateGroups(id, type, body = {}) {
    const previous = this.overridePending.get(id) || Promise.resolve();
    const operation = previous.then(async () => {
      const data = await this.get(id);
      if (!data) throw new Error("找不到运行记录");
      if (data.run.status !== "completed") throw new Error("分析完成后才能修正分组");
      const base = await this.results(id);
      const operations = [...data.groupOverrides.operations];
      if (type === "undo") operations.pop();
      else operations.push({
        ...body, type, newGroupId: `group:manual:${randomUUID()}`, updatedAt: new Date().toISOString()
      });
      const groups = applyGroupOverrides(base.groups, base.results, operations);
      const groupOverrides = { contractVersion: 1, operations };
      await this.writeAtomic(id, "group-overrides.json", groupOverrides);
      await this.saveReviewSummary(id, groups);
      return { groups, groupOverrides };
    });
    const queued = operation.catch(() => {});
    this.overridePending.set(id, queued);
    try {
      return await operation;
    } finally {
      if (this.overridePending.get(id) === queued) this.overridePending.delete(id);
    }
  }
}
