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

test("embedding groups do not chain dissimilar scenes or compare partial dimensions", () => {
  const vector=degrees=>[Math.cos(degrees*Math.PI/180),Math.sin(degrees*Math.PI/180)];
  const items=[{id:"a",embedding:vector(0),qualityScore:90},{id:"b",embedding:vector(20),qualityScore:80},{id:"c",embedding:vector(40),qualityScore:70}];
  const groups=clusterByEmbedding(items,0.9);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].items.map(item=>item.id),["a","b"]);
  assert.deepEqual(clusterByEmbedding([...items].reverse(),0.9),groups);
  assert.equal(cosineSimilarity([1],[1,10]),0);
  assert.equal(clusterByEmbedding([{id:"a",embedding:[1]},{id:"b",embedding:[1,10]}],0.9).length,2);
  assert.equal(clusterByEmbedding([{id:"a",embedding:[0,0]},{id:"b",embedding:[0,0]}],0).length,2);
  assert.equal(clusterByEmbedding([{id:"a",embedding:[NaN,1]},{id:"b",embedding:[NaN,1]}],0).length,2);
  assert.throws(()=>clusterByEmbedding(items,NaN),/threshold/);
});
