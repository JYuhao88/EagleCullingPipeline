import assert from "node:assert/strict";
import test from "node:test";
import { createBatchItemReader, createProgressSummary } from "../src/plugin/batch-items.js";
import { runBoundedQueue } from "../src/plugin/task-queue.js";

test("8000 items at concurrency 128 use batch reads and incremental counters", async () => {
  const items = Array.from({ length: 8000 }, (_, id) => ({ id: String(id), status: "pending" }));
  let calls = 0;
  const read = createBatchItemReader({ async getByIds(ids) {
    calls += 1;
    assert.ok(ids.length <= 256);
    return ids.map((id) => ({ id, modifiedAt: 123 }));
  } });
  const progress = createProgressSummary(items);
  const result = await runBoundedQueue({ items, concurrency: 128,
    process: async (entry) => assert.equal((await read(entry.id)).id, entry.id),
    onProgress: (entry) => progress.update(entry.item.id, entry.status),
  });
  assert.equal(result.succeeded, 8000);
  assert.equal(calls, 63);
  assert.deepEqual(progress.summary, { total: 8000, succeeded: 8000, skipped: 0, failed: 0 });
});

test("missing items, duplicate ids and fresh retry reads", async () => {
  let version = 0;
  const read = createBatchItemReader({ async getByIds(ids) {
    version += 1;
    assert.deepEqual(ids, ["a", "missing"]);
    return [{ id: "a", modifiedAt: version }];
  } });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const [a, duplicate, missing] = await Promise.all([read("a"), read("a"), read("missing")]);
    assert.equal(a.modifiedAt, attempt);
    assert.equal(a, duplicate);
    assert.equal(missing, undefined);
  }
});

test("batch failure rejects all readers and next retry works", async () => {
  let calls = 0;
  const read = createBatchItemReader({ async getByIds(ids) {
    if (++calls === 1) throw new Error("Eagle unavailable");
    return ids.map((id) => ({ id }));
  } });
  const results = await Promise.allSettled([read("a"), read("b")]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal((await read("a")).id, "a");
});

test("older API fallback and resumed counters stay correct", async () => {
  const read = createBatchItemReader({ async getById(id) { return { id }; } });
  assert.equal((await read("a")).id, "a");
  const progress = createProgressSummary([{ id: "a", status: "succeeded" }, { id: "b", status: "failed" }]);
  progress.update("b", "succeeded");
  progress.update("b", "succeeded");
  assert.deepEqual(progress.summary, { total: 2, succeeded: 2, skipped: 0, failed: 0 });
});
