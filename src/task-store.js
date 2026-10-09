import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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
    badgeSha256: item.badgeSha256 ?? null,
    status: item.status || "pending",
    attempts: Number(item.attempts) || 0,
    error: item.error ?? null,
    updatedAt: item.updatedAt || now(),
    result: item.result ?? null,
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
    execution: input.execution || null,
    requiresExecution: Boolean(input.requiresExecution),
    activationPending: input.activationPending === true,
    upload: input.upload || null,
    config: input.config || { concurrency: 8, delayMs: 0, maxAttempts: 3 },
    items: Array.isArray(input.items) ? input.items.map(normalizeItem) : [],
    summary: input.summary || { total: Array.isArray(input.items) ? input.items.length : 0, succeeded: 0, skipped: 0, failed: 0, pending: Array.isArray(input.items) ? input.items.length : 0, paused: 0, cancelled: 0 },
    errors: Array.isArray(input.errors) ? input.errors : [],
  };
}

export class TaskStore {
  constructor(filePath = path.resolve("data", "tasks.json")) {
    this.filePath = filePath;
    this.tasks = new Map();
    this.journalPath = `${filePath}.journal`;
    this.operations = Promise.resolve();
    this.ready = this.load();
    // HTTP handlers report storage errors; never crash from an early unobserved
    // rejected load promise before the first task request arrives.
    this.ready.catch(() => {});
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.tasks;
      for (const task of list || []) this.tasks.set(task.taskId, normalizeTask(task));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let journal;
    try { journal = await readFile(this.journalPath); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const lastNewline = journal.lastIndexOf(10);
    // A power loss can leave one incomplete append. Preserve it for diagnosis,
    // then remove only that incomplete tail, never a committed event.
    if (lastNewline + 1 < journal.length) {
      await writeFile(`${this.journalPath}.incomplete-${crypto.randomUUID()}`, journal.subarray(lastNewline + 1), { flag: "wx" });
      const handle = await open(this.journalPath, "r+");
      try { await handle.truncate(lastNewline + 1); await handle.sync(); }
      finally { await handle.close(); }
    }
    for (const line of journal.subarray(0, lastNewline + 1).toString("utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (crypto.createHash("sha256").update(record.payload).digest("hex") !== record.sha256) throw new Error("Task journal checksum mismatch; refusing unsafe recovery");
      this.applyEvent(JSON.parse(record.payload));
    }
  }

  transaction(operation) {
    const pending = this.operations.catch(() => {}).then(async () => { await this.ready; return operation(); });
    this.operations = pending;
    return pending;
  }

  async commit(event) {
    if (this.persistenceError) throw new Error(`Task persistence stopped after an I/O failure; restart to recover: ${this.persistenceError.message}`);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(event);
    const bytes = JSON.stringify({ sha256: crypto.createHash("sha256").update(payload).digest("hex"), payload }) + "\n";
    const handle = await open(this.journalPath, "a");
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
    catch (error) { this.persistenceError = error; throw error; }
    finally { await handle.close(); }
    return this.applyEvent(event);
  }

  applyEvent(event) {
    if (event.type === "create") {
      const task = normalizeTask(event.task);
      task.summary = summarizeItems(task.items);
      this.tasks.set(task.taskId, task);
      return task;
    }
    const current = this.tasks.get(event.taskId);
    if (!current) throw new Error("Journal references an unknown task");
    if (event.type === "append") {
      const items = [...current.items, ...event.items];
      const next = { ...current, items, upload: event.upload, summary: summarizeItems(items), updatedAt: event.at };
      this.tasks.set(event.taskId, next);
      return next;
    }
    if (event.type === "update") {
      const next = { ...current, ...event.patch, updatedAt: event.at };
      if (event.patch.items) next.summary = summarizeItems(next.items);
      this.tasks.set(event.taskId, next);
      return next;
    }
    if (event.type !== "items") throw new Error("Invalid journal event");
    const updates = new Map(event.updates.map((entry) => [String(entry.itemId ?? entry.id), entry]));
    const summary = { ...current.summary };
    const errors = [...current.errors];
    const items = current.items.map((item) => {
      const patch = updates.get(item.id);
      if (!patch) return item;
      const updated = normalizeItem({ ...item, ...patch, id: item.id, updatedAt: event.at });
      summary[item.status] = (summary[item.status] || 0) - 1;
      summary[updated.status] = (summary[updated.status] || 0) + 1;
      if (updated.error) errors.push({ itemId: item.id, error: updated.error, at: event.at });
      return updated;
    });
    const next = { ...current, items, summary, errors: errors.slice(-100), updatedAt: event.at };
    this.tasks.set(event.taskId, next);
    return next;
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
    return this.transaction(() => {
      const task = normalizeTask(input);
      task.execution = null;
      if (task.activationPending) { task.status = "paused"; task.requiresExecution = true; }
      if (input.upload) {
        if (!Number.isSafeInteger(input.upload.expectedTotal) || input.upload.expectedTotal < 1 || task.items.length) throw new Error("Upload requires a positive expectedTotal and initially empty items");
        task.status = "uploading";
        task.upload = { expectedTotal: input.upload.expectedTotal, chunks: [], sealed: false };
      }
      if (this.tasks.has(task.taskId)) throw new Error("Task id already exists");
      if (new Set(task.items.map((item) => item.id)).size !== task.items.length) throw new Error("Duplicate item ids are not allowed");
      return this.commit({ type: "create", task });
    });
  }

  async appendPlan(taskId, { offset, items }) {
    return this.transaction(() => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      if (!current.upload || current.status === "cancelled") throw Object.assign(new Error("Task is not accepting a plan upload"), { statusCode: 409 });
      if (!Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(items) || !items.length || items.some(item => typeof item.id !== "string" || !item.id)) throw new Error("Valid offset and non-empty items with string ids are required");
      const sha256 = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
      const previous = current.upload.chunks.find(chunk => chunk.offset === offset);
      if (previous) {
        if (previous.sha256 !== sha256 || previous.count !== items.length) throw Object.assign(new Error("Repeated chunk differs from the persisted plan"), { statusCode: 409 });
        return current;
      }
      if (current.status !== "uploading" || current.upload.sealed) throw Object.assign(new Error("Task is not accepting a plan upload"), { statusCode: 409 });
      if (offset !== current.items.length || offset + items.length > current.upload.expectedTotal) throw Object.assign(new Error("Plan offset or expected total mismatch"), { statusCode: 409 });
      const ids = new Set(current.items.map(item => item.id));
      for (const item of items) {
        if (ids.has(item.id)) throw new Error("Duplicate item ids are not allowed");
        ids.add(item.id);
      }
      const upload = { ...current.upload, chunks: [...current.upload.chunks, { offset, count: items.length, sha256 }] };
      return this.commit({ type: "append", taskId, items: items.map(normalizeItem), upload, at: now() });
    });
  }

  async sealPlan(taskId) {
    return this.transaction(() => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      if (current.upload?.sealed) return current;
      if (current.status !== "uploading" || !current.upload || current.items.length !== current.upload.expectedTotal) throw Object.assign(new Error("Cannot execute an incomplete plan upload"), { statusCode: 409 });
      return this.commit({ type: "update", taskId, patch: { status: current.activationPending ? "paused" : "pending", upload: { ...current.upload, sealed: true } }, at: now() });
    });
  }

  async update(taskId, patch) {
    return this.transaction(() => this.tasks.has(taskId) ? this.commit({ type: "update", taskId, patch, at: now() }) : null);
  }

  async updateItem(taskId, itemId, patch) {
    return this.updateItems(taskId, [{ ...patch, itemId }]);
  }

  async updateItems(taskId, updates = [], ownerId) {
    return this.transaction(() => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      this.assertOwner(current, ownerId);
      const knownIds = new Set(current.items.map((item) => item.id));
      if (updates.some((entry) => !knownIds.has(String(entry.itemId ?? entry.id)))) throw new Error("Unknown task item");
      return this.commit({ type: "items", taskId, updates, at: now() });
    });
  }

  assertOwner(task, ownerId) {
    if (task.requiresExecution && !task.execution) throw Object.assign(new Error("任务未持有执行权，拒绝写回断点"), { statusCode: 409 });
    if ((task.execution || ownerId) && task.execution?.ownerId !== ownerId) throw Object.assign(new Error("任务执行权不匹配，停止旧窗口写回"), { statusCode: 409 });
  }

  async execution(taskId, action, { ownerId, libraryPath, confirmed = false, activate = false } = {}) {
    return this.transaction(async () => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      if (typeof ownerId !== "string" || !ownerId.length) throw new Error("ownerId is required");
      if (libraryPath !== current.libraryPath) throw Object.assign(new Error("资源库不匹配"), { statusCode: 409 });
      const at = now();
      if (action === "claim") {
        const activating = current.activationPending && activate === true && current.status === "paused";
        if ((!activating && current.activationPending) || (!activating && !["pending", "running"].includes(current.status))) throw Object.assign(new Error("任务不是可执行状态；待确认计划需显式激活并领取执行权"), { statusCode: 409 });
        if (current.execution?.ownerId && current.execution.ownerId !== ownerId) throw Object.assign(new Error("任务已由另一个窗口持有；失联不会自动抢占"), { statusCode: 409 });
        const other = [...this.tasks.values()].find((task) => task.taskId !== taskId && task.libraryPath === libraryPath && (task.execution || task.status === "running"));
        if (other) throw Object.assign(new Error("资源库有其他运行窗口或未释放的执行权"), { statusCode: 409 });
        return this.commit({ type: "update", taskId, patch: { status: "running", activationPending: false, requiresExecution: true, execution: { ownerId, heartbeatAt: at } }, at });
      }
      this.assertOwner(current, ownerId);
      if (action === "heartbeat") return this.commit({ type: "update", taskId, patch: { execution: { ownerId, heartbeatAt: at } }, at });
      if (action === "release") return this.commit({ type: "update", taskId, patch: { execution: null }, at });
      if (action === "recover") {
        if (!confirmed || !current.execution || Date.now() - Date.parse(current.execution.heartbeatAt) < 30000) throw Object.assign(new Error("需确认旧窗口已关闭，且执行者至少失联 30 秒；不会自动抢占"), { statusCode: 409 });
        return this.commit({ type: "update", taskId, patch: { execution: null, status: ["pending", "running"].includes(current.status) ? "paused" : current.status }, at });
      }
      throw new Error("Unsupported execution action");
    });
  }

  async command(taskId, command, ownerId) {
    return this.transaction(async () => {
      const current = this.tasks.get(taskId);
      if (!current) return null;
      if (current.status === "uploading" && command !== "cancel") throw Object.assign(new Error("Complete the plan upload before controlling execution"), { statusCode: 409 });
      if (current.activationPending && ["resume","retry","start","complete","fail"].includes(command)) throw Object.assign(new Error("待确认计划只能显式激活并原子领取执行权"), {statusCode:409});
      if (["complete", "fail", "start"].includes(command)) this.assertOwner(current, ownerId);
      // Remote pause/cancel wins a race with the worker's final completion.
      if (["complete", "fail"].includes(command) && ["paused", "cancelled"].includes(current.status)) return current;
      if (["resume", "retry"].includes(command) && current.execution) throw Object.assign(new Error("执行者仍在结束在途请求，请等待释放执行权"), { statusCode: 409 });
      const statuses = { pause: ["pending", "running"].includes(current.status) ? "paused" : current.status, resume: current.status === "paused" ? "running" : current.status, cancel: "cancelled", start: "running", complete: "succeeded", fail: "failed", retry: "pending" };
      if (!(command in statuses)) return null;
      if (command === "retry") {
        const updates = current.items.filter((item) => item.status === "failed").map((item) => ({ itemId: item.id, status: "pending", error: null }));
        if (updates.length) await this.commit({ type: "items", taskId, updates, at: now() });
      }
      return this.commit({ type: "update", taskId, patch: { status: statuses[command], ...(command === "retry" ? { error: null } : {}) }, at: now() });
    });
  }
}

export function summarizeItems(items = []) {
  const summary = { total: items.length, succeeded: 0, skipped: 0, failed: 0, pending: 0, running: 0, paused: 0, cancelled: 0 };
  for (const item of items) summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}
