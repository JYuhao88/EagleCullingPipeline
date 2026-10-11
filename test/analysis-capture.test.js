import test from "node:test";
import assert from "node:assert/strict";
import { buildCaptureUnits } from "../src/core/capture-units.js";
import { groupResults, GROUPING_CONFIG } from "../src/core/grouping.js";
test("capture units pair same stem and skip deleted items", () => {
  const units = buildCaptureUnits([
    { id: "jpg", name: "IMG_1.jpg", ext: "jpg" },
    { id: "raw", name: "IMG_1.arw", ext: "arw" },
    { id: "deleted", name: "IMG_2.jpg", ext: "jpg", isDeleted: true },
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].pairing, "paired");
  assert.deepEqual(units[0].itemIds, ["jpg", "raw"]);
});
test("grouping uses hash and time thresholds", () => {
  const groups = groupResults(
    [
      { unitId: "a", phash: "0000", captureTime: "2024-01-01T00:00:00Z" },
      { unitId: "b", phash: "0001", captureTime: "2024-01-01T00:00:05Z" },
      {
        unitId: "c",
        phash: "1111111111111111",
        captureTime: "2024-01-01T01:00:00Z",
      },
    ],
    GROUPING_CONFIG,
  );
  assert.equal(groups.length, 2);
  assert.equal(
    groups.find((group) => group.unitIds.includes("a")).unitIds.length,
    2,
  );
});

test("chain-like similarity is split by group diameter while a real burst stays together", () => {
  const at = (seconds) => new Date(Date.parse("2024-01-01T00:00:00Z") + seconds * 1000).toISOString();
  const chain = groupResults([
    { unitId: "a", phash: "0".repeat(64), embedding: [1, 0], captureTime: at(0) },
    { unitId: "b", phash: "0".repeat(63) + "1", embedding: [1, 0], captureTime: at(1) },
    { unitId: "c", phash: "0".repeat(62) + "11", embedding: [1, 0], captureTime: at(7) },
  ], { ...GROUPING_CONFIG, maxTimeSpanSeconds: 3 });
  assert.ok(chain.length >= 2);
  const burst = groupResults([
    { unitId: "x", phash: "0".repeat(64), embedding: [1, 0], captureTime: at(0) },
    { unitId: "y", phash: "0".repeat(63) + "1", embedding: [1, 0], captureTime: at(1) },
    { unitId: "z", phash: "0".repeat(62) + "11", embedding: [1, 0], captureTime: at(2) },
  ], { ...GROUPING_CONFIG, maxTimeSpanSeconds: 3 });
  assert.equal(burst.length, 1);
  assert.equal(burst[0].size, 3);
});

test("visual A-B-C links cannot override complete-link diameter", () => {
  const vector = (angle) => [Math.cos(angle), Math.sin(angle)];
  const groups = groupResults([0, 0.3, 0.6].map((angle, i) => ({
    unitId: String(i), embedding: vector(angle), captureTime: 1000 + i * 100,
  })), { embeddingSimilarity: 0.78, minPairScore: 0.5, minDiameterScore: 0.9,
    temporalBonus: 0, sequenceBonus: 0 });
  assert.equal(groups.length, 2);
  assert.equal(Math.max(...groups.map((group) => group.size)), 2);
});
