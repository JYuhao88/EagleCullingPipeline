import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFile } from './atomic-file.js';

// Decisions made on photos that no finished analysis covers yet, per library and Eagle item. The first finished
// analysis that covers a photo takes its decision over; until then it only lives here.
export class PendingDecisions {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }

  async readAll() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, libraries: {} }; throw error; }
  }

  async get(libraryPath, itemId) {
    return (await this.readAll()).libraries?.[libraryPath]?.[itemId] || null;
  }

  // Writes are chained so concurrent requests never lose each other's rows.
  serial(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  async save(all) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(all, null, 2), 'utf8');
    await replaceFile(temporary, this.file);
  }

  // decision: { action, reason? } or { clear: true }. `unchanged(now)` lets callers skip echoes of the saved row.
  decide(libraryPath, itemId, decision, { unchanged = () => false, now = new Date() } = {}) {
    if (typeof decision.reason === 'string' && decision.reason.length > 500)
      return Promise.reject(new Error('Decision reason must be a string of at most 500 characters'));
    return this.serial(async () => {
      const all = await this.readAll();
      const rows = all.libraries[libraryPath] ||= {};
      if (unchanged(rows[itemId]?.action)) return { unchanged: true, row: rows[itemId] || null };
      if (decision.clear) delete rows[itemId];
      else rows[itemId] = { action: decision.action, ...(typeof decision.reason === 'string' ? { reason: decision.reason } : {}),
        updatedAt: now.toISOString() };
      if (!Object.keys(rows).length) delete all.libraries[libraryPath];
      await this.save(all);
      return { row: rows[itemId] || null };
    });
  }

  // Hands pending decisions to a finished analysis: one per photo unit, the newest among its items, unless the run
  // already holds a newer decision for that unit. Taken rows leave the pending list.
  adopt(libraryPath, units, target) {
    return this.serial(async () => {
      const all = await this.readAll();
      const rows = all.libraries?.[libraryPath];
      if (!rows) return 0;
      const taken = [], chosen = new Map();
      for (const unit of units) {
        const ids = (unit.itemIds?.length ? unit.itemIds : [unit.primaryItemId]).filter(id => rows[id]);
        if (!ids.length) continue;
        taken.push(...ids);
        const newest = ids.map(id => rows[id]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        chosen.set(unit.id, newest);
      }
      if (!chosen.size) return 0;
      const merged = new Map((await target.read()).map(row => [row.unitId, row]));
      let count = 0;
      for (const [unitId, row] of chosen) {
        const existing = merged.get(unitId);
        if (existing && Date.parse(existing.updatedAt || 0) >= Date.parse(row.updatedAt)) continue;
        merged.set(unitId, { contractVersion: 1, unitId, action: row.action, ...(row.reason ? { reason: row.reason } : {}),
          source: 'human', updatedAt: row.updatedAt, beforeAnalysis: true });
        count++;
      }
      if (count) await target.write([...merged.values()]);
      for (const id of taken) delete rows[id];
      if (!Object.keys(rows).length) delete all.libraries[libraryPath];
      await this.save(all);
      return count;
    });
  }
}
