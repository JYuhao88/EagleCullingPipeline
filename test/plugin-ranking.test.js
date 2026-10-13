import test from "node:test";
import assert from "node:assert/strict";
import { reviewGroups } from "../src/server/runs-routes.js";

test("old run confidence and close-score reason are computed without changing stored groups", () => {
  const data = { groups: [{ id: "old", unitIds: ["a", "b"], ranking: [
    { unitId: "b", rank: 2, score: 0.8 }, { unitId: "a", rank: 1, score: 0.81, reasons: ["综合分最高"] }
  ] }], results: [] };
  const original = structuredClone(data);
  const [group] = reviewGroups(data);
  assert.equal(group.confidence, "low");
  assert.equal(group.margin, 0.01);
  assert.ok(group.ranking[1].reasons.includes("与第二名很接近，建议人工确认"));
  assert.deepEqual(data, original);
});
