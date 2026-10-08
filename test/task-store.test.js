import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";

test("task store persists progress and retries only failed items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-task-store-"));
  const filePath = path.join(root, "tasks.json");
  const store = new TaskStore(filePath);
  const task = await store.create({ taskType: "badge-thumbnails-library", items: [{ id: "a" }, { id: "b" }] });
  await store.updateItem(task.taskId, "a", { status: "succeeded", attempts: 1, outputPath: "a.png" });
  await store.updateItem(task.taskId, "b", { status: "failed", attempts: 3, error: "missing" });
  const retry = await store.command(task.taskId, "retry");
  assert.equal(retry.status, "pending");
  assert.equal(retry.items.find((item) => item.id === "a").status, "succeeded");
  assert.equal(retry.items.find((item) => item.id === "b").status, "pending");
  const reloaded = new TaskStore(filePath);
  const persisted = await reloaded.get(task.taskId);
  assert.equal(persisted.items.find((item) => item.id === "a").outputPath, "a.png");
  assert.ok((await readFile(filePath, "utf8")).includes(task.taskId));
});
