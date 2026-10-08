import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function makeId() {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeItem(item) {
  return {
    id: String(item.id),
    modifiedAt: item.modifiedAt ?? null,
    outputPath: item.outputPath ?? null,
    status: item.status || "pending",
    attempts: Number(item.attempts) || 0,
    error: item.error ?? null,
    updatedAt: item.updatedAt || now(),
  };
}

function normalizeTask(input) {
  const createdAt = input.createdAt || now();
  return {
    taskId: input.taskId || makeId(),
    taskType: input.taskType || "unknown",
    createdAt,
    updatedAt: input.updatedAt || createdAt,
    libraryPath: input.libraryPath || null,
    manifestVersion: input.manifestVersion || null,
    status: input.status || "pending",
    attempts: Number(input.attempts) || 0,
    outputPath: input.outputPath || null,
    error: input.error || null,
    config: input.config || { concurrency: 2, delayMs: 120, maxAttempts: 3 },
    items: Array.isArray(input.items) ? input.items.map(normalizeItem) : [],
    summary: input.summary || { total: Array.isArray(input.items) ? input.items.length : 0, succeeded: 0, skipped: 0, failed: 0, pending: Array.isArray(input.items) ? input.items.length : 0, paused: 0, cancelled: 0 },
    errors: Array.isArray(input.errors) ? input.errors : [],
  };
}

export class TaskStore {
  constructor(filePath = path.resolve("data", "tasks.json")) {
    this.filePath = filePath;
    this.tasks = new Map();
    this.writeChain = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.tasks;
      for (const task of list || []) this.tasks.set(task.taskId, normalizeTask(task));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    const payload = JSON.stringify({ version: DEFAULT_VERSION, updatedAt: now(), tasks: [...this.tasks.values()] }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    });
    return this.writeChain;
  }

  async list({ includeItems = true } = {}) {
    await this.ready;
    const tasks = [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return includeItems ? tasks : tasks.map(({ items, ...task }) => task);
  }

  async get(taskId) {
    await this.ready;
    return this.tasks.get(taskId) || null;
  }

  async create(input) {
    await this.ready;
    const task = normalizeTask(input);
    this.tasks.set(task.taskId, task);
    await this.persist();
    return task;
  }

  async update(taskId, patch) {
    await this.ready;
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const next = normalizeTask({ ...current, ...patch, taskId, updatedAt: now() });
    this.tasks.set(taskId, next);
    await this.persist();
    return next;
  }

  async updateItem(taskId, itemId, patch) {
    await this.ready;
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const items = current.items.map((item) => item.id === String(itemId) ? normalizeItem({ ...item, ...patch, updatedAt: now() }) : item);
    const summary = summarizeItems(items);
    const errors = patch.error ? [...current.errors, { itemId: String(itemId), error: patch.error, at: now() }].slice(-100) : current.errors;
    return this.update(taskId, { items, summary, errors });
  }

  async updateItems(taskId, updates = []) {
    await this.ready;
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const byId = new Map(updates.map((entry) => [String(entry.itemId ?? entry.id), entry]));
    const items = current.items.map((item) => byId.has(item.id) ? normalizeItem({ ...item, ...byId.get(item.id), updatedAt: now() }) : item);
    return this.update(taskId, { items, summary: summarizeItems(items) });
  }

  async command(taskId, command) {
    await this.ready;
    const current = this.tasks.get(taskId);
    if (!current) return null;
    if (command === "pause") return this.update(taskId, { status: current.status === "running" || current.status === "pending" ? "paused" : current.status });
    if (command === "resume") return this.update(taskId, { status: current.status === "paused" ? "running" : current.status });
    if (command === "cancel") return this.update(taskId, { status: "cancelled" });
    if (command === "start") return this.update(taskId, { status: "running" });
    if (command === "complete") return this.update(taskId, { status: "succeeded" });
    if (command === "fail") return this.update(taskId, { status: "failed" });
    if (command === "retry") {
      const items = current.items.map((item) => item.status === "failed" ? normalizeItem({ ...item, status: "pending", error: null }) : item);
      return this.update(taskId, { items, status: "pending", error: null, summary: summarizeItems(items) });
    }
    return null;
  }
}

export function summarizeItems(items = []) {
  const summary = { total: items.length, succeeded: 0, skipped: 0, failed: 0, pending: 0, running: 0, paused: 0, cancelled: 0 };
  for (const item of items) summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}
