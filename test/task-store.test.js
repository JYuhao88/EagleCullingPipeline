import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";

test("task store persists progress and retries only failed items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-task-store-"));
  const filePath = path.join(root, "tasks.json");
  const store = new TaskStore(filePath);
  const task = await store.create({ taskType: "badge-thumbnails-library", items: [{ id: "a" }, { id: "b" }] });
  await store.updateItem(task.taskId, "a", { status: "succeeded", attempts: 1, outputPath: "a.png", result: { phash: "0000", qualityScore: 80 } });
  await store.updateItem(task.taskId, "b", { status: "failed", attempts: 3, error: "missing" });
  const retry = await store.command(task.taskId, "retry");
  assert.equal(retry.status, "pending");
  assert.equal(retry.items.find((item) => item.id === "a").status, "succeeded");
  assert.equal(retry.items.find((item) => item.id === "b").status, "pending");
  const reloaded = new TaskStore(filePath);
  const persisted = await reloaded.get(task.taskId);
  assert.equal(persisted.items.find((item) => item.id === "a").outputPath, "a.png");
  assert.equal(persisted.items.find((item) => item.id === "a").result.qualityScore, 80);
  assert.ok((await readFile(`${filePath}.journal`, "utf8")).includes(task.taskId));
});

test("concurrent checkpoints and pause never overwrite each other", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-concurrent-store-"));
  const filePath = path.join(root, "tasks.json");
  const store = new TaskStore(filePath);
  const task = await store.create({ status: "running", items: Array.from({ length: 100 }, (_, id) => ({ id: String(id) })) });
  await Promise.all([...task.items.map((item) => store.updateItem(task.taskId, item.id, { status: "succeeded" })), store.command(task.taskId, "pause")]);
  const restored = await new TaskStore(filePath).get(task.taskId);
  assert.equal(restored.summary.succeeded, 100);
  assert.equal(restored.status, "paused");
});

test("legacy snapshot is preserved, incomplete final append recovered, corrupted complete event rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-journal-recovery-"));
  const filePath = path.join(root, "tasks.json");
  const legacy = JSON.stringify({ tasks: [{ taskId: "old", items: [{ id: "a" }], status: "paused" }] });
  await writeFile(filePath, legacy);
  const store = new TaskStore(filePath);
  await store.updateItem("old", "a", { status: "succeeded", result: { qualityScore: 90 } });
  assert.equal(await readFile(filePath, "utf8"), legacy);
  await appendFile(`${filePath}.journal`, '{"incomplete":');
  const recovered = new TaskStore(filePath);
  assert.equal((await recovered.get("old")).summary.succeeded, 1);
  await recovered.command("old", "resume");
  assert.equal((await new TaskStore(filePath).get("old")).status, "running");
  const journal = await readFile(`${filePath}.journal`, "utf8");
  await writeFile(`${filePath}.journal`, journal.replace('"sha256":"', '"sha256":"corrupt'));
  await assert.rejects(new TaskStore(filePath).get("old"), /checksum/);
});
