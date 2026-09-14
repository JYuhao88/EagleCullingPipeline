import assert from "node:assert/strict";
import test from "node:test";
import { buildPairPlan, buildPairUpdate } from "../src/pairing.js";

test("creates a capture unit for a one-to-one JPG and RAW pair", () => {
  const plan = buildPairPlan([
    { id: "jpg", name: "DSC0001", ext: "jpg" },
    { id: "raw", name: "DSC0001", ext: "arw" },
  ]);
  assert.equal(plan.pairedUnits, 1);
  assert.deepEqual(plan.updates.find((item) => item.id === "raw").additions, ["ai:paired", "ai:original"]);
  assert.deepEqual(plan.updates.find((item) => item.id === "jpg").additions, ["ai:paired"]);
});

test("marks duplicate basenames as uncertain instead of guessing pairs", () => {
  const plan = buildPairPlan([
    { id: "jpg1", name: "DSC0001", ext: "jpg" },
    { id: "jpg2", name: "DSC0001", ext: "jpg" },
    { id: "raw1", name: "DSC0001", ext: "arw" },
  ]);
  assert.equal(plan.uncertainUnits, 1);
  assert.ok(plan.updates.every((item) => item.additions.includes("ai:pair-uncertain")));
});

test("pair tags merge without changing review tags or stars", () => {
  const update = buildPairUpdate({ id: "raw", tags: ["travel", "ai:candidate", "ai:pair-uncertain"], star: 5 }, { additions: ["ai:paired", "ai:original"] });
  assert.deepEqual(update, { id: "raw", tags: ["travel", "ai:candidate", "ai:paired", "ai:original"] });
});
