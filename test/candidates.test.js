import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateSet, candidateDimensions } from "../src/core/candidates.js";

const item = (unitId, metrics, flags = []) => ({ unitId, metrics, flags });

test("epsilon Pareto keeps complementary leaders and explains them", () => {
  const set = buildCandidateSet([
    item("sharp", { sharpness: .9, exposure: .5, quality: .5 }),
    item("quality", { sharpness: .5, exposure: .5, quality: .9 }),
  ]);
  assert.deepEqual(new Set(set.unitIds), new Set(["sharp", "quality"]));
  assert.ok(set.entries.every(entry => entry.leaders.length));
});

test("all severe flags produce an empty candidate set without a fallback", () => {
  const set = buildCandidateSet([
    item("a", { sharpness: .2 }, ["blurry"]), item("b", { sharpness: .3 }, ["eyes-closed"]),
  ]);
  assert.equal(set.rejectedAll, true);
  assert.deepEqual(set.unitIds, []);
});

test("missing dimensions abstain instead of becoming zero", () => {
  assert.equal(candidateDimensions(item("a", { quality: .8 })).sharpness, null);
});
