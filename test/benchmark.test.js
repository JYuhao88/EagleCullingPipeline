import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmark } from "../src/benchmark.js";

test("benchmark includes duplicate groups and is deterministic", async () => {
  const analysis = {
    generatedAt: "now",
    items: [{ id: "a", name: "a" }, { id: "b", name: "b" }, { id: "c", name: "c" }],
    groups: [{ groupId: "g", size: 2, items: [{ id: "a" }, { id: "b" }] }, { groupId: "s", size: 1, items: [{ id: "c" }] }],
  };
  const first = await buildBenchmark(analysis, 3);
  const second = await buildBenchmark(analysis, 3);
  assert.deepEqual(first.items.map((x) => x.id), second.items.map((x) => x.id));
  assert.deepEqual(new Set(first.items.map((x) => x.id)), new Set(["a", "b", "c"]));
});

