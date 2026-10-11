import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// HTTP requests create separate store instances for the same run.
const pendingUpdates = new Map();

export class DecisionsStore {
  constructor(runDir) {
    this.runDir = runDir;
    this.file = path.join(runDir, "decisions.json");
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(value) ? value : Object.values(value);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async write(decisions) {
    await mkdir(this.runDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(decisions, null, 2), "utf8");
    await rename(temporary, this.file);
    return decisions;
  }

  async upsert(decisions) {
    const key = path.resolve(this.file);
    const operation = (pendingUpdates.get(key) || Promise.resolve()).then(() => this.update(decisions));
    const pending = operation.catch(() => {});
    pendingUpdates.set(key, pending);
    try { return await operation; }
    finally { if (pendingUpdates.get(key) === pending) pendingUpdates.delete(key); }
  }

  async update(decisions) {
    const current = new Map((await this.read()).map(item => [item.unitId, item]));
    for (const decision of decisions) {
      if (decision.clear === true) {
        current.delete(decision.unitId);
        continue;
      }
      current.set(decision.unitId, {
        contractVersion: 1,
        ...decision,
        source: "human",
        updatedAt: decision.updatedAt || new Date().toISOString()
      });
    }
    return this.write([...current.values()]);
  }

  async effective(results, groups) {
    const stored = new Map((await this.read()).map(item => [item.unitId, item]));
    const suggested = new Map();
    for (const group of groups || []) {
      for (const unitId of group.unitIds || []) {
        suggested.set(unitId, group.suggested?.[unitId] || "candidate");
      }
    }
    return (results || []).map(result => stored.get(result.unitId) || {
      contractVersion: 1,
      unitId: result.unitId,
      action: suggested.get(result.unitId) || "candidate",
      flags: [],
      source: "suggested",
      updatedAt: null
    });
  }
}

export function decisionFile(runDir) {
  return new DecisionsStore(runDir);
}
