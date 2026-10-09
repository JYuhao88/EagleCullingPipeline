import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedQueue } from "../src/plugin/task-queue.js";
import { registeredThumbnailIds } from "../src/plugin/thumbnail-ownership.js";

test("resume preserves successful records and does not reapply them", async () => {
  const items = [{ id: "done", status: "succeeded", attempts: 2 }, { id: "new", status: "pending" }];
  const processed = [];
  const result = await runBoundedQueue({ items, delayMs: 0, shouldSkip: (item) => item.status === "succeeded", process: async (item) => processed.push(item.id), onProgress: async (result) => { result.item.status = result.status; } });
  assert.deepEqual(processed, ["new"]);
  assert.equal(items[0].status, "succeeded");
  assert.equal(items[0].attempts, 2);
  assert.equal(result.succeeded, 1);
});

test("checkpoint failure never retries an already applied Eagle mutation", async () => {
  let writes = 0;
  await assert.rejects(runBoundedQueue({ items: [{ id: "one" }], delayMs: 0, process: async () => { writes += 1; }, onProgress: async () => { throw new Error("disk unavailable"); } }), /disk unavailable/);
  assert.equal(writes, 1);
});

test("explicit skipped results remain skipped", async () => {
  const result = await runBoundedQueue({ items: [{ id: "changed" }], delayMs: 0, process: async () => ({ status: "skipped", error: "modifiedAt changed" }) });
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].error, "modifiedAt changed");
});

test("restore ownership requires successful writes in the same library", () => {
  const tasks = [
    { createdAt: "1", libraryPath: "a", taskType: "badge-thumbnails-library", items: [{ id: "owned", status: "succeeded", outputPath: "one.png" }, { id: "failed", status: "failed", outputPath: "two.png" }] },
    { createdAt: "2", libraryPath: "b", taskType: "badge-thumbnails-library", items: [{ id: "other-library", status: "succeeded", outputPath: "three.png" }] },
    { createdAt: "3", libraryPath: "a", taskType: "restore-thumbnails", items: [{ id: "owned", status: "succeeded" }] },
  ];
  assert.deepEqual([...registeredThumbnailIds(tasks, "a")], []);
  assert.deepEqual([...registeredThumbnailIds(tasks, "b")], ["other-library"]);
});

for (const concurrency of [1, 2, 4, 8, 16, 32, 48]) test(`8,000 items respect concurrency ${concurrency}`, async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedQueue({ items: Array.from({ length: 8000 }, (_, id) => ({ id })), concurrency, delayMs: 0, process: async () => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; } });
  assert.equal(result.succeeded, 8000);
  assert.ok(peak <= concurrency);
  assert.equal(peak, concurrency);
});
