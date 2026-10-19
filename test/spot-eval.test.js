import test from "node:test";
import assert from "node:assert/strict";
import { decisionsToLabels, evaluateWeights, fitPairwiseWeights, pairwiseSamples, scoreLabels } from "../src/core/spot-eval.js";

const data = (groups, results) => ({ run: { id: "toy" }, groups, results });

test("heldout evaluation leaves unrelated groups unranked and preserves missing/unable labels", () => {
  const fixture = data([{ id: "g", unitIds: ["a", "b"] }], [
    { unitId: "a", metrics: { sharpness: 0.9, exposure: 0.5, quality: 0.5, faces: 1, eyesClosed: 0 } },
    { unitId: "b", metrics: { sharpness: 0.2, exposure: 0.5, quality: 0.5, faces: 1, eyesClosed: 0 } }
  ]);
  const labels = [{ groupId: "g", bestUnitId: "a" }, { groupId: "missing", bestUnitId: "absent" },
    { groupId: "missing", bestUnitId: null }];
  const expected = evaluateWeights(fixture, labels, [1, 0, 0, 0]);
  fixture.groups.push({ id: "unused", unitIds: ["unused"] });
  fixture.results.push({ unitId: "unused", get metrics() { throw new Error("Unrelated group was ranked"); } });
  assert.deepEqual(evaluateWeights(fixture, labels, [1, 0, 0, 0]), expected);
  assert.equal(expected.top1.rate, 1);
  assert.equal(expected.unable, 1);
});

test("spot scoring skips unable labels and computes top-1 and pairwise", () => {
  const resultsData = data([{ id: "g", unitIds: ["a", "b"], ranking: [
    { unitId: "a", rank: 1, score: 0.9 }, { unitId: "b", rank: 2, score: 0.2 },
  ] }], []);
  const report = scoreLabels(resultsData, [
    { groupId: "g", bestUnitId: "a" }, { groupId: "g", bestUnitId: null },
  ]);
  assert.deepEqual(report.top1, { hits: 1, total: 1, rate: 1 });
  assert.deepEqual(report.pairwise, { wins: 1, total: 1, rate: 1 });
  assert.equal(report.unable, 1);
});

test("pairwise fitting gives a higher weight to clearer images", () => {
  const results = [
    { unitId: "a", metrics: { sharpness: 0.9, exposure: 0.5, faces: 1, eyesClosed: 0, quality: 0.5 } },
    { unitId: "b", metrics: { sharpness: 0.1, exposure: 0.5, faces: 1, eyesClosed: 0, quality: 0.5 } },
  ];
  const result = data([{ id: "g", unitIds: ["a", "b"] }], results);
  const { samples } = pairwiseSamples(result, [{ groupId: "g", bestUnitId: "a" }]);
  const weights = fitPairwiseWeights(samples);
  assert.ok(weights[0] > weights[1]);
  assert.equal(weights.reduce((sum, value) => sum + value, 0), 1);
});

test("留存 photos are left out of labels, pairwise samples and evaluation", () => {
  const metrics = value => ({ metrics: { sharpness: value, exposure: value, quality: value, faces: 1, eyesClosed: 0 } });
  const data = { groups: [
      { id: "g1", unitIds: ["a", "b", "k"], ranking: [{ unitId: "k", rank: 1, score: 0.9 }, { unitId: "a", rank: 2, score: 0.8 },
        { unitId: "b", rank: 3, score: 0.1 }] },
      { id: "g2", unitIds: ["c", "k2"] }],
    results: [{ unitId: "a", ...metrics(0.8) }, { unitId: "b", ...metrics(0.2) }, { unitId: "k", ...metrics(0.9) },
      { unitId: "c", ...metrics(0.5) }, { unitId: "k2", ...metrics(0.4) }] };
  const human = (unitId, action) => ({ unitId, action, source: "human" });
  const labels = decisionsToLabels(data, [human("a", "selected"), human("k", "record"), human("c", "selected"), human("k2", "record")]);
  assert.deepEqual(labels, [{ groupId: "g1", bestUnitId: "a", excluded: ["k"] }], "a group left with one judged photo teaches nothing");
  const { samples } = pairwiseSamples(data, labels);
  assert.deepEqual(samples.map(sample => sample.otherUnitId), ["b"]);
  const score = scoreLabels(data, labels);
  assert.deepEqual([score.top1.hits, score.pairwise.total], [1, 1], "the model is judged on the photos you compared");
});
