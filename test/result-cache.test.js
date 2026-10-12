import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import sharp from "sharp";
import { AnalysisPipeline } from "../src/core/pipeline.js";
import { completeEyeRois, detectorFaces } from "../src/core/eye-roi.js";

test("detectorFaces removes pose-completed faces and eye ROIs", () => {
  const detector = { box: [0.1, 0.1, 0.5, 0.5], confidence: 0.9, eyeBoxes: [[0.2, 0.2, 0.25, 0.25]] };
  const completed = [
    { box: [0.1, 0.1, 0.5, 0.5], confidence: 0.9, eyeBoxes: [[0.2, 0.2, 0.25, 0.25], [0.3, 0.2, 0.35, 0.25]],
      eyeRoiSource: "rtmw-68", eyeRoiConfidence: 0.8 },
    detector,
    { box: [0.6, 0.1, 0.9, 0.5], eyesAssessed: false, eyesClosed: false, roiSource: "rtmw-face" },
  ];
  assert.deepEqual(detectorFaces(completed), [{ box: [0.1, 0.1, 0.5, 0.5], confidence: 0.9 }, detector]);
  assert.deepEqual(detectorFaces(completeEyeRois([detector])), [detector]);
});

test("result cache survives a moved cache directory and restores detector faces", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eagle-result-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const filePath = path.join(dir, "photo.jpg");
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#808080" } })
    .composite([{ input: Buffer.from("<svg width='64' height='48'><rect x='8' y='8' width='20' height='20' fill='#fff'/></svg>") }])
    .jpeg().toFile(filePath);
  const info = await stat(filePath);
  const record = { unitId: "u1", id: "u1", filePath, size: info.size, mtimeMs: info.mtimeMs, ext: "jpg", width: 64, height: 48 };
  const rows = new Map();
  const store = { get: async key => structuredClone(rows.get(key) ?? null),
    put: async (key, value) => rows.set(key, structuredClone(value)) };
  let analyzed = 0;
  const poseFaces = [];
  const options = cacheRoot => ({
    root: path.join(dir, "no-models"), cacheRoot, store, concurrency: 1,
    analyzer: async () => { analyzed += 1; return { metrics: {}, score: 0.5 }; },
    faceDetector: async paths => paths.map(() => ({ faces: 1, eyesClosed: 0,
      faceDetails: [{ box: [0.1, 0.1, 0.5, 0.6], confidence: 0.9 }] })),
    poseDetector: async items => {
      poseFaces.push(structuredClone(items.map(item => item.faces)));
      return items.map(() => ({ available: false }));
    },
  });
  const first = await new AnalysisPipeline(options(path.join(dir, "a"))).run([{ ...record }], { nativeFocus: false });
  const stored = rows.get(first.results[0].fingerprint);
  stored.faces.push({ box: [0.6, 0.1, 0.9, 0.5], eyesAssessed: false, eyesClosed: false, roiSource: "rtmw-face" });
  await cp(path.join(dir, "a"), path.join(dir, "b"), { recursive: true });
  await rm(path.join(dir, "a"), { recursive: true, force: true });
  const second = await new AnalysisPipeline(options(path.join(dir, "b"))).run([{ ...record }], { nativeFocus: false });
  assert.equal(analyzed, 1);
  assert.equal(second.results[0].fingerprint, first.results[0].fingerprint);
  assert.ok(second.results[0].previewPath.startsWith(path.join(dir, "b")));
  assert.deepEqual(poseFaces[1], poseFaces[0]);
  assert.equal(second.results[0].metrics.exposure, first.results[0].metrics.exposure);
});
