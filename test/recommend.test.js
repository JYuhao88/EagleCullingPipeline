import assert from "node:assert/strict";
import test from "node:test";
import { buildRecommendations } from "../src/recommend.js";

test("recommends the highest quality member of a duplicate group", async () => {
  const review = await buildRecommendations({ generatedAt: "now", groups: [{ groupId: "g", size: 2, items: [
    { id: "low", qualityScore: 20 }, { id: "high", qualityScore: 90 },
  ] }] });
  assert.deepEqual(review.decisions.map((d) => [d.id, d.action]), [["high", "selected"], ["low", "rejected"]]);
});

test("marks singleton groups as candidates instead of rejecting them", async () => {
  const review = await buildRecommendations({ generatedAt: "now", groups: [{ groupId: "g", size: 1, items: [{ id: "one", qualityScore: 50 }] }] });
  assert.equal(review.decisions[0].action, "candidate");
});

