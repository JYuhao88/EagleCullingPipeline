import assert from "node:assert/strict";
import test from "node:test";
import { buildPairPlan, buildPairUpdate, buildPairedReviewUpdates } from "../src/pairing.js";

test("creates a capture unit for a one-to-one JPG and RAW pair", () => {
  const plan = buildPairPlan([
    { id: "jpg", name: "DSC0001", ext: "jpg" },
    { id: "raw", name: "DSC0001", ext: "arw" },
  ]);
  assert.equal(plan.pairedUnits, 1);
  assert.deepEqual(plan.updates.find((item) => item.id === "raw").additions, ["AI已配对", "AI原片"]);
  assert.deepEqual(plan.updates.find((item) => item.id === "jpg").additions, ["AI已配对"]);
});

test("marks duplicate basenames as uncertain instead of guessing pairs", () => {
  const plan = buildPairPlan([
    { id: "jpg1", name: "DSC0001", ext: "jpg" },
    { id: "jpg2", name: "DSC0001", ext: "jpg" },
    { id: "raw1", name: "DSC0001", ext: "arw" },
  ]);
  assert.equal(plan.uncertainUnits, 1);
  assert.ok(plan.updates.every((item) => item.additions.includes("AI配对待确认")));
});

test("preserves an unpaired RAW as an original needing pair review", () => {
  const plan = buildPairPlan([{ id: "raw", name: "DSC0002", ext: "arw" }]);
  assert.equal(plan.unpairedOriginals, 1);
  assert.deepEqual(plan.updates[0].additions, ["AI原片", "AI未配对原片"]);
});

test("pair tags merge without changing review tags or stars", () => {
  const update = buildPairUpdate({ id: "raw", tags: ["travel", "ai:candidate", "ai:pair-uncertain"], star: 5 }, { additions: ["ai:paired", "ai:original"] });
  assert.deepEqual(update, { id: "raw", tags: ["travel", "ai:candidate", "AI已配对", "AI原片"] });
});

test("copies JPG review and quality tags to its exact RAW pair", () => {
  const updates = buildPairedReviewUpdates([
    { id: "jpg", name: "DSC0003", ext: "jpg", tags: ["旅行", "AI精选", "AI过曝"] },
    { id: "raw", name: "DSC0003", ext: "arw", tags: ["AI原片", "AI已配对", "人工标签", "AI候选"] },
  ]);
  assert.deepEqual(updates[0], {
    id: "raw",
    tags: ["AI原片", "AI已配对", "人工标签", "AI精选", "AI过曝"],
    sourceId: "jpg",
    captureUnitId: "pair:dsc0003",
    syncTags: ["AI精选", "AI过曝"],
  });
});
