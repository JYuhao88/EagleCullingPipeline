import { LearningData } from "../core/learning-data.js";
import path from "node:path";
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { applyGroupOverrides } from "../core/group-overrides.js";

export class RunStore {
  constructor(root = "data/runs") {
    this.root = path.resolve(root);
    this.pending = new Map();
    this.overridePending = new Map();
    this.unitIndexes = new Map();
    this.resultSnapshots = new Map();
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
        await this.writeAtomic(run.id, "results.json", resultData);
        if (run.status === "completed") {
          try { await this.learningData.ingestRun(resultData); }
          catch (error) { runJson.learningWarning = error.message; }
        }
      }
      if (!metadataOnly && state.applied) {
        await writeFile(path.join(directory, "applied.json"), JSON.stringify(state.applied, null, 2));
      }
      // Publish terminal status only after its result payload is durable.
      await this.writeAtomic(run.id, "run.json", runJson);
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
    await rename(temporary, file);
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
