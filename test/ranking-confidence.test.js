import test from "node:test";
import assert from "node:assert/strict";
import { CONFIDENCE_MARGIN_THRESHOLD, groupConfidence, rankGroup } from "../src/core/ranking.js";
import { decisionsToLabels, pairwiseSamples } from "../src/core/spot-eval.js";

const group = (first, second) => ({ unitIds: ["a", "b"], ranking: [
  { unitId: "b", rank: 2, score: second }, { unitId: "a", rank: 1, score: first },
] });

test("confidence uses the top two ranks with an inclusive high-confidence threshold", () => {
  assert.equal(CONFIDENCE_MARGIN_THRESHOLD, 0.03);
  assert.deepEqual(groupConfidence(group(0.8, 0.78)), { confidence: "low", margin: 0.02 });
  assert.deepEqual(groupConfidence(group(0.8, 0.77)), { confidence: "high", margin: 0.03 });
  assert.deepEqual(groupConfidence({ unitIds: ["a"], ranking: [] }), { confidence: "single", margin: null });
  assert.deepEqual(groupConfidence({ unitIds: ["a", "b"] }), { confidence: "low", margin: null });
});

test("serious issues on the first choice force confirmation regardless of score gap", () => {
  for (const flag of ["blurry", "eyes-closed", "overexposed", "underexposed"]) {
    assert.equal(groupConfidence(group(0.9, 0.2), [{ unitId: "a", flags: [flag] }]).confidence, "low");
    assert.equal(groupConfidence(group(0.9, 0.2), [{ unitId: "b", flags: [flag] }]).confidence, "high");
  }
  assert.equal(groupConfidence(group(0.9, 0.2), [{ unitId: "a", flags: ["possibly-blurry"] }]).confidence, "high");
});

test("near-tied ranking explains why the first choice needs manual confirmation", () => {
  const ranking = rankGroup([
    { unitId: "a", metrics: { sharpness: 0.8 } }, { unitId: "b", metrics: { sharpness: 0.78 } },
  ], { sharpness: 1 });
  assert.ok(ranking[0].reasons.includes("与第二名很接近，建议人工确认"));
  assert.equal(ranking[1].reasons.includes("与第二名很接近，建议人工确认"), false);
  const clear = rankGroup([
    { unitId: "a", metrics: { sharpness: 0.8 } }, { unitId: "b", metrics: { sharpness: 0.4 } },
  ], { sharpness: 1 });
  assert.equal(clear[0].reasons.includes("与第二名很接近，建议人工确认"), false);
});

test("decisions labels accept exactly one human selection per multi-image group", () => {
  const data = { groups: [
    { id: "one", unitIds: ["a", "b"] }, { id: "two", unitIds: ["c", "d"] },
    { id: "none", unitIds: ["e", "f"] }, { id: "single", unitIds: ["g"] },
  ] };
  const decisions = [
    { unitId: "a", source: "human", action: "selected" },
    { unitId: "b", source: "suggested", action: "selected" },
    { unitId: "c", source: "human", action: "selected" },
    { unitId: "d", source: "human", action: "selected" },
    { unitId: "e", source: "human", action: "candidate" },
    { unitId: "f", source: "suggested", action: "selected" },
    { unitId: "g", source: "human", action: "selected" },
  ];
  assert.deepEqual(decisionsToLabels(data, decisions), [{ groupId: "one", bestUnitId: "a" }]);
  assert.deepEqual(decisionsToLabels(data, Object.fromEntries(decisions.map(item => [item.unitId, item]))),
    [{ groupId: "one", bestUnitId: "a" }]);
  assert.deepEqual(decisionsToLabels(data), []);
});

test("missing analysis results do not produce pairwise training samples", () => {
  const data = { groups: [{ id: "g", unitIds: ["a", "b"] }], results: [] };
  assert.deepEqual(pairwiseSamples(data, [{ groupId: "g", bestUnitId: "a" }]), { samples: [], trainingGroups: 0 });
});
