import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedQueue } from "../src/task-queue.js";

test("bounded queue handles 8,000 items with retry and checkpoint callbacks", async () => {
  const items = Array.from({ length: 8000 }, (_, index) => ({ id: index }));
  const attempts = new Map();
  const completed = new Set();
  let checkpoints = 0;
  const result = await runBoundedQueue({
    items,
    concurrency: 4,
    delayMs: 0,
    maxAttempts: 3,
    process: async (item, attempt) => {
      const count = (attempts.get(item.id) || 0) + 1;
      attempts.set(item.id, count);
      if (item.id % 97 === 0 && attempt < 2) throw new Error("transient");
      completed.add(item.id);
    },
    onProgress: async (entry) => { if ((entry.item.id + 1) % 25 === 0) checkpoints += 1; },
  });
  assert.equal(result.succeeded, 8000);
  assert.equal(result.failed, 0);
  assert.equal(completed.size, 8000);
  assert.ok(checkpoints >= 300);
  assert.ok([...attempts.values()].some((count) => count > 1));
});

test("bounded queue can stop at a pause boundary and resume remaining items", async () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ id: index }));
  let paused = false;
  let processed = 0;
  const first = await runBoundedQueue({ items, concurrency: 2, delayMs: 1, shouldPause: () => paused, process: async () => { processed += 1; if (processed === 10) paused = true; } });
  assert.ok(first.succeeded >= 10);
  const seen = new Set(first.results.map(({ item }) => item.id));
  paused = false;
  const second = await runBoundedQueue({ items: items.filter((item) => !seen.has(item.id)), concurrency: 2, delayMs: 0, process: async () => {} });
  assert.equal(first.succeeded + second.succeeded, 40);
});
