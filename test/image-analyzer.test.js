import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { analyzeImage, applyFaceQuality, clusterByPhash, hammingDistance, listEagleImages } from "../src/image-analyzer.js";

async function fixtureLibrary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-culling-"));
  const info = path.join(root, "images", "TESTITEM000001.info");
  await mkdir(info, { recursive: true });
  const buffer = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 220, g: 80, b: 40 } } }).png().toBuffer();
  await writeFile(path.join(info, "sample.png"), buffer);
  await writeFile(path.join(info, "metadata.json"), JSON.stringify({ id: "TESTITEM000001", name: "sample", ext: "png", width: 96, height: 96 }));
  const duplicate = path.join(root, "images", "TESTITEM000002.info");
  await mkdir(duplicate, { recursive: true });
  await cp(path.join(info, "sample.png"), path.join(duplicate, "sample-copy.png"));
  await writeFile(path.join(duplicate, "metadata.json"), JSON.stringify({ id: "TESTITEM000002", name: "sample-copy", ext: "png", width: 96, height: 96 }));
  return root;
}

test("lists Eagle .info image records and analyzes a local sample", async () => {
  const root = await fixtureLibrary();
  const records = await listEagleImages(root);
  assert.equal(records.length, 2);
  const result = await analyzeImage(records[0]);
  assert.equal(result.sha256.length, 64);
  assert.equal(result.phash.length, 63);
  assert.ok(result.qualityScore >= 0 && result.qualityScore <= 100);
  assert.ok(result.metrics.sharpness >= 0);
});

test("clusters exact duplicates and reports a zero hash distance", async () => {
  const root = await fixtureLibrary();
  const records = await listEagleImages(root);
  const analyzed = await Promise.all(records.map(analyzeImage));
  assert.equal(hammingDistance(analyzed[0].phash, analyzed[1].phash), 0);
  const groups = clusterByPhash(analyzed, 8);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 2);
});

test("closed eyes become an explicit quality flag and score penalty", () => {
  const result = applyFaceQuality({ qualityScore: 80, confidence: 0.78, qualityFlags: [] }, {
    faceCount: 1,
    faces: [{ eyesClosed: true }],
  });
  assert.equal(result.qualityFlags.includes("eyes-closed"), true);
  assert.equal(result.qualityScore, 55);
});
