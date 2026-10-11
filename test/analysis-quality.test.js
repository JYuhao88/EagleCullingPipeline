import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { choosePreview } from "../src/core/previews.js";
import { analyzeImage, normalizeMetrics, measureFaceExposure, exposureSuitability } from "../src/core/metrics.js";
import { rankGroup, gateFlags, suggestDecision, groupConfidence } from "../src/core/ranking.js";
import { score } from "../src/core/scorer.js";

test("preview normalizes EXIF orientation and rejects uniform output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-preview-"));
  const source = path.join(root, "oriented.jpg");
  const pixels = Buffer.alloc(80 * 40 * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    pixels[index] = index % 255;
    pixels[index + 1] = 20;
    pixels[index + 2] = 20;
  }
  await sharp(pixels, { raw: { width: 80, height: 40, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toFile(source);
  const preview = await choosePreview(
    { filePath: source, ext: "jpg" },
    { cacheDir: path.join(root, "cache") },
  );
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.orientation, undefined);
  assert.ok(metadata.height > metadata.width);
  await rm(root, { recursive: true, force: true });
});

test("ranking reasons and suggestions are mutually consistent", () => {
  const items = [
    { unitId: "a", metrics: { sharpness: 0.8, exposure: 0.8 }, flags: [] },
    {
      unitId: "b",
      metrics: { sharpness: 0.3, exposure: 0.8 },
      flags: ["possibly-blurry"],
    },
  ];
  const ranking = rankGroup(items);
  assert.ok(!ranking[0].reasons.includes("可能模糊"));
  assert.ok(ranking[1].reasons.includes("比首选更模糊"));
  assert.ok(!ranking[1].reasons.includes("最清晰"));
  const single = rankGroup([
    { unitId: "x", metrics: { sharpness: 0.8, exposure: 0.8 }, flags: [] },
  ]);
  assert.ok(single[0].reasons.includes("清晰"));
  assert.ok(!single[0].reasons.includes("最清晰"));
});

test("exposure suitability peaks in a usable band instead of increasing with brightness", () => {
  const values = [20, 60, 110, 160, 220].map((meanLuma) =>
    normalizeMetrics({ meanLuma, clippedHigh: meanLuma >= 220 ? 0.12 : 0, clippedLow: meanLuma <= 20 ? 0.12 : 0 }).exposure,
  );
  assert.ok(values[2] > values[0]);
  assert.ok(values[2] >= values[3]);
  assert.ok(values[2] > values[4]);
});

test("face highlight clipping is a gate with an explainable reason", () => {
  const ranking = rankGroup([
    { unitId: "bright-face", metrics: { sharpness: 1, exposure: 1, quality: 1,
      raw: { faceExposure: { meanLuma: 190, clippedHigh: 0.2, clippedLow: 0 } } } },
    { unitId: "usable", metrics: { sharpness: 0.6, exposure: 0.6, quality: 0.6 } },
  ]);
  assert.equal(ranking[0].unitId, "usable");
  assert.ok(!ranking[0].reasons.includes("与第二名很接近，建议人工确认"));
  assert.ok(ranking[0].reasons.includes("通过门槛者中综合分最高"));
  assert.equal(groupConfidence({ unitIds: ranking.map((r) => r.unitId), ranking }).margin, null);
  assert.ok(ranking[1].reasons.includes("硬伤门槛：排在通过者之后"));
});

test("measured face highlights reduce suitability even on a usable background", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-face-exposure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, "face.png");
  const pixels = Buffer.alloc(100 * 100 * 3, 110);
  for (let y = 20; y < 40; y += 1) {
    for (let x = 20; x < 40; x += 1) pixels.fill(255, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  }
  await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } }).png().toFile(image);
  const faceExposure = await measureFaceExposure(image, [{ box: [0.2, 0.2, 0.4, 0.4] }]);
  assert.ok(faceExposure.clippedHigh > 0.8);
  assert.ok(exposureSuitability({ faceExposure }) < exposureSuitability({ meanLuma: 110, midtoneFraction: 1 }));
  assert.equal(normalizeMetrics({ sharpness: 0.5 }, { sharpnessScale: 100 }).sharpness, 0.005);
});

test("hard blur and closed eyes cannot outrank usable images; low-key intent survives", () => {
  const items = [
    { unitId: "blur", metrics: { sharpness: 0.001, quality: 1 } },
    { unitId: "blink", metrics: { sharpness: 1, quality: 1, faces: 1, eyesClosed: 1 } },
    { unitId: "low-key", metrics: { sharpness: 0.2, quality: 0.5, clippedShadows: 0.5,
      raw: { faceExposure: { meanLuma: 40, clippedHigh: 0, clippedLow: 0.01 } } } },
  ];
  assert.deepEqual(gateFlags(items[2]), []);
  assert.deepEqual(gateFlags({ metrics: { sharpness: 0.014 }, flags: ["possibly-blurry"] }), ["possibly-blurry"]);
  const ranking = rankGroup(items);
  assert.equal(ranking[0].unitId, "low-key");
  for (const entry of ranking.slice(1)) {
    assert.ok(entry.reasons.includes("硬伤门槛：排在通过者之后"));
    assert.equal(suggestDecision(entry, items.find((i) => i.unitId === entry.unitId), items.length), "rejected");
  }
});

test("leader reasons name only metrics the top unit clearly leads", () => {
  const ranking = rankGroup([
    { unitId: "a", metrics: { sharpness: 0.9, exposure: 0.8, faces: 1, eyesClosed: 0 } },
    { unitId: "b", metrics: { sharpness: 0.5, exposure: 0.8, faces: 1, eyesClosed: 0 } },
  ]);
  assert.deepEqual(ranking[0].reasons.slice(0, 2), ["综合分最高", "清晰度组内最高"]);
  assert.ok(!ranking[0].reasons.includes("曝光组内最高"));
  assert.ok(!ranking[0].reasons.includes("睁眼率组内最高"));
});

test("ranking drops missing metrics and normalizes the remaining weights", () => {
  const ranking = rankGroup([
    { unitId: "a", metrics: { sharpness: 1, exposure: 1, quality: null } },
    { unitId: "b", metrics: { sharpness: 0, exposure: 1, quality: null } },
  ]);
  assert.equal(ranking[0].score, 1);
  assert.equal(ranking[1].score, 0.4);
});

test("ranking uses only metrics shared by every group member", () => {
  const ranking = rankGroup([
    { unitId: "a", metrics: { sharpness: 1, exposure: 0, faces: 1, eyesClosed: 0 } },
    { unitId: "b", metrics: { sharpness: 0, exposure: 1, faces: 0, eyesClosed: null } },
  ]);
  assert.equal(ranking[0].score, 0.6);
  assert.equal(ranking[1].score, 0.4);
});

test("ranking ignores quality for a partially scored group", () => {
  const ranking = rankGroup([
    { unitId: "a", metrics: { sharpness: 0.2, exposure: 1, quality: 0.99 } },
    { unitId: "b", metrics: { sharpness: 0.8, exposure: 1, quality: null } },
  ]);
  assert.equal(ranking[0].unitId, "b");
  assert.equal(ranking[0].score, 0.88);
  assert.equal(ranking[1].score, 0.52);
});

test("ONNX scorer returns a calibrated result when the model is available", async (t) => {
  try {
    await access(path.join(process.cwd(), "models/scorer/topiq_nr_512.onnx"));
  } catch {
    t.skip("TOPIQ-NR 模型不存在，跳过真实推理");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-scorer-"));
  const image = path.join(root, "image.jpg");
  await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#808080" },
  }).jpeg().toFile(image);
  const result = (await score([image]))[0];
  assert.equal(result.model, "topiq-nr-onnx");
  assert.equal(result.calibrated, true);
  assert.ok(result.quality === null || (result.quality >= 0 && result.quality <= 1));
  await rm(root, { recursive: true, force: true });
});
