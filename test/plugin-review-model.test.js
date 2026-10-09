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
  assert.deepEqual(tags, ["旅行", "ai:paired", "ai:possibly-blurry", "AI精选"]);
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

test("unavailable eye detection is explicitly reviewable, never described as normal eyes", () => {
  const record = buildReviewSections([{id:"one",tags:[],face:{available:false}}])[0].records[0];
  assert.ok(record.reasons[0].includes("检测未完成"));
  assert.equal(summarize([record]).issues,1);
  assert.equal(matchesReviewFilter(record,"issues"),true);
});

test("no detected face is not a landscape defect; incomplete eyes are explicitly reviewable", () => {
  const records=buildReviewSections([
    {id:"landscape",tags:[],qualityFlags:[],face:{available:true,faceCount:0}},
    {id:"portrait",tags:[],qualityFlags:[],face:{available:true,eyeAssessment:"incomplete"}},
    {id:"checked",tags:[],qualityFlags:[],face:{available:true,eyeAssessment:"no-closed-signal"}},
  ])[0].records;
  assert.ok(records[0].reasons.some(reason=>reason.includes("不代表画面无人或眼睛正常")));
  assert.equal(matchesReviewFilter(records[0],"issues"),false);
  assert.equal(matchesReviewFilter(records[1],"issues"),true);
  assert.equal(summarize(records).issues,1);
  assert.ok(records[2].reasons.some(reason=>reason.includes("不保证所有人物眼睛正常")));
});

test("obsolete scores appear in the review-issues count and filter while human selection stays", () => {
  const record = buildReviewSections([{id:"old",tags:["AI精选"],qualityFlags:[],analysisStale:true,analysisStaleReasons:["scoring-version"]}])[0].records[0];
  assert.equal(summarize([record]).issues,1);
  assert.equal(summarize([record]).selected,1);
  assert.equal(matchesReviewFilter(record,"issues","评分算法"),true);
  assert.equal(record.recommendation,"candidate");
});

test("heuristic ranking is not described as a validated subject or aesthetic model", () => {
  const reasons = chineseReasons({id:"proxy",qualityMethod:"heuristic-preview",qualityScore:80,qualityFlags:[],tags:[]});
  assert.ok(reasons.some(reason=>reason.includes("不是审美模型评分")));
  assert.ok(reasons.some(reason=>reason.includes("准确率尚未校准")));
});
