import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEagleImages } from "../src/core/metrics.js";
import { buildCaptureUnits } from "../src/core/capture-units.js";
import { AnalysisPipeline } from "../src/core/pipeline.js";

const library = process.env.EAGLE_LIBRARY_PATH || "/unconfigured/expected.library";
const model = "models/dinov2-small/model.onnx";

test("fixture grouping reaches paired F1 target when assets exist", async (t) => {
  try {
    await access(library);
    await access(model);
  } catch {
    t.skip("测试库或 DINOv2 模型不存在，跳过真实分析");
    return;
  }
  const labels = JSON.parse(
    await readFile("test/fixtures/fixture-groups.json", "utf8"),
  );
  const scope = labels.scope ? new Set(labels.scope) : null;
  const items = (await listEagleImages(library)).filter(
    (item) => !scope || scope.has(String(item.name).replace(/\.[^.]+$/, "")),
  );
  const units = buildCaptureUnits(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const records = units.map((unit) => ({
    ...byId.get(unit.primaryItemId),
    unitId: unit.id,
    itemIds: unit.itemIds,
  }));
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "eagle-group-fixture-"));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const result = await new AnalysisPipeline({
    cacheRoot,
    concurrency: 1,
    store: null,
  }).run(records);
  const unitByStem = new Map(
    units.map((unit) => {
      const item = byId.get(unit.primaryItemId);
      return [String(item.name).replace(/\.[^.]+$/, ""), unit.id];
    }),
  );
  const predicted = new Set();
  for (const group of result.groups) {
    for (const left of group.unitIds) {
      for (const right of group.unitIds) {
        if (left < right) predicted.add(`${left}|${right}`);
      }
    }
  }
  const expected = new Set(
    (labels.groups || []).flatMap((group) => {
      const ids = (group.unitIds || group).map(
        (value) => unitByStem.get(value) || value,
      );
      return ids.flatMap((left, i) =>
        ids
          .slice(i + 1)
          .map((right) =>
            left < right ? `${left}|${right}` : `${right}|${left}`,
          ),
      );
    }),
  );
  const uncertain = new Set(
    (labels.uncertain || []).map(([left, right]) => {
      const a = unitByStem.get(left) || left;
      const b = unitByStem.get(right) || right;
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    }),
  );
  const relevant = [...expected].filter((pair) => !uncertain.has(pair));
  const tp = relevant.filter((pair) => predicted.has(pair)).length;
  const fp = [...predicted].filter(
    (pair) => relevant.includes(pair) === false,
  ).length;
  const fn = relevant.length - tp;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  t.diagnostic(JSON.stringify({ units: records.length, groups: result.groups.length,
    maxGroupSize: Math.max(...result.groups.map((g) => g.unitIds.length)), tp, fp, fn, precision, recall, f1 }));
  assert.ok(f1 >= 0.88, `paired F1 ${f1.toFixed(3)} below W6 baseline`);
  assert.equal(fp, 0, "no false-positive pairs versus W6 baseline");
  assert.ok(tp >= 22 && fn <= 6, "pair recall must meet W6 baseline");
});
