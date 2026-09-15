import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewSections,
  chineseReasons,
  matchesReviewFilter,
  mergeReviewStateTags,
  reviewStateFromTags,
  summarize,
} from "../src/plugin/review-model.js";

test("merges only the AI review state and preserves human, pair, and quality tags", () => {
  const tags = mergeReviewStateTags(["旅行", "ai:candidate", "ai:paired", "ai:possibly-blurry"], "selected");
  assert.deepEqual(tags, ["旅行", "ai:paired", "ai:possibly-blurry", "ai:selected"]);
  assert.equal(reviewStateFromTags(tags), "selected");
});

test("explains quality, pairing, proxy analysis, and similar groups in Chinese", () => {
  const item = { id: "raw", tags: ["ai:original", "ai:paired"], qualityFlags: ["overexposed"], metrics: { clippedHigh: 0.083 }, analysisSource: "proxy" };
  const reasons = chineseReasons(item, { size: 2, representativeId: "jpg" });
  assert.ok(reasons.some((reason) => reason.includes("高光溢出 8.3%")));
  assert.ok(reasons.some((reason) => reason.includes("母片保护")));
  assert.ok(reasons.some((reason) => reason.includes("拍摄配对")));
  assert.ok(reasons.some((reason) => reason.includes("预览图分析")));
  assert.ok(reasons.some((reason) => reason.includes("组内首选")));
});

test("builds similarity sections and keeps conservative singleton recommendations", () => {
  const items = [
    { id: "best", name: "A", tags: ["ai:candidate"], qualityScore: 90 },
    { id: "other", name: "B", tags: [], qualityScore: 70 },
    { id: "single", name: "C", tags: ["ai:rejected"], qualityScore: 60 },
  ];
  const groups = [{ groupId: "phash-0001", size: 2, representativeId: "best", items: items.slice(0, 2) }];
  const sections = buildReviewSections(items, groups);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0].records.map((record) => record.recommendation), ["selected", "rejected"]);
  assert.equal(sections[1].records[0].recommendation, "candidate");
});

test("summaries and filters use current Eagle review tags", () => {
  const records = buildReviewSections([
    { id: "a", name: "Portrait", tags: ["ai:selected"], qualityFlags: [] },
    { id: "b", name: "Portrait 2", tags: ["ai:rejected"], qualityFlags: ["eyes-closed"] },
  ])[0].records;
  assert.deepEqual(summarize(records), { total: 2, selected: 1, candidate: 0, rejected: 1, issues: 1 });
  assert.equal(matchesReviewFilter(records[1], "issues", "闭眼"), true);
  assert.equal(matchesReviewFilter(records[0], "rejected", ""), false);
});
