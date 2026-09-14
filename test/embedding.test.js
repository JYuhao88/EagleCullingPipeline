import assert from "node:assert/strict";
import test from "node:test";
import { clusterByEmbedding, cosineSimilarity } from "../src/embedding.js";

test("computes cosine similarity and embedding clusters", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  const groups = clusterByEmbedding([
    { id: "a", embedding: [1, 0], qualityScore: 2 },
    { id: "b", embedding: [0.99, 0.01], qualityScore: 3 },
    { id: "c", embedding: [0, 1], qualityScore: 5 },
  ], 0.9);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.size === 2).representativeId, "b");
});

