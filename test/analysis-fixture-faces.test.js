import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { listEagleImages } from "../src/core/metrics.js";
import { buildCaptureUnits } from "../src/core/capture-units.js";
import { AnalysisPipeline } from "../src/core/pipeline.js";

test("fixture face detection recall and false positives", async (t) => {
  const library = process.env.EAGLE_LIBRARY_PATH || "/unconfigured/expected.library";
  try {
    await access(library);
    await access("models/mediapipe/face_landmarker.task");
    await access(process.env.EAGLE_PYTHON || "python_worker/.venv/bin/python");
  } catch {
    t.skip("测试库、人脸模型或 python_worker/.venv 不存在，跳过真实检测");
    return;
  }
  const labels = JSON.parse(
    await readFile("test/fixtures/fixture-faces.json", "utf8"),
  );
  const items = await listEagleImages(library);
  const units = buildCaptureUnits(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const records = units.map((unit) => ({
    ...byId.get(unit.primaryItemId),
    unitId: unit.id,
    itemIds: unit.itemIds,
  }));
  const result = await new AnalysisPipeline({ store: null }).run(records);
  const detected = new Set(
    result.results
      .filter((item) => item.metrics.faces > 0)
      .map((item) => item.name),
  );
  const truePositives = labels.faces.filter((name) =>
    detected.has(name),
  ).length;
  const falsePositives = labels.nonFaces.filter((name) =>
    detected.has(name),
  ).length;
  assert.ok(truePositives / labels.faces.length >= 0.85);
  assert.ok(falsePositives <= 2);
});
