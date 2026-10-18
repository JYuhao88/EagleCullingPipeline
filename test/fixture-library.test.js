import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEagleImages } from "../src/core/metrics.js";
import { buildCaptureUnits } from "../src/core/capture-units.js";
import { AnalysisPipeline } from "../src/core/pipeline.js";

const library = process.env.EAGLE_FIXTURE_LIBRARY;
const assets = ["models/dinov2-small/model.onnx", "models/mediapipe/face_landmarker.task",
  process.env.EAGLE_PYTHON || "python_worker/.venv/bin/python"];
const stem = (name) => String(name).replace(/\.[^.]+$/, "");
const pair = (left, right) => (left < right ? `${left}|${right}` : `${right}|${left}`);

test("fixture library reaches face recall and paired grouping F1 baselines",
  { skip: !library && "set EAGLE_FIXTURE_LIBRARY to the labelled fixture library to run real face and grouping analysis" },
  async (t) => {
    for (const file of [library, ...assets]) await access(file);
    const faceLabels = JSON.parse(await readFile("test/fixtures/fixture-faces.json", "utf8"));
    const labels = JSON.parse(await readFile("test/fixtures/fixture-groups.json", "utf8"));
    const scope = labels.scope ? new Set(labels.scope) : null;
    const items = (await listEagleImages(library)).filter((item) => !scope || scope.has(stem(item.name)));
    const units = buildCaptureUnits(items);
    const byId = new Map(items.map((item) => [item.id, item]));
    const records = units.map((unit) => ({ ...byId.get(unit.primaryItemId), unitId: unit.id, itemIds: unit.itemIds }));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "eagle-fixture-library-"));
    t.after(() => rm(cacheRoot, { recursive: true, force: true }));
    const result = await new AnalysisPipeline({ cacheRoot, concurrency: 1, store: null }).run(records);

    const detected = new Set(result.results.filter((item) => item.metrics.faces > 0).map((item) => item.name));
    const truePositives = faceLabels.faces.filter((name) => detected.has(name)).length;
    const falsePositives = faceLabels.nonFaces.filter((name) => detected.has(name)).length;
    assert.ok(truePositives / faceLabels.faces.length >= 0.85, `face recall ${truePositives}/${faceLabels.faces.length}`);
    assert.ok(falsePositives <= 2, `face false positives ${falsePositives}`);

    const unitByStem = new Map(units.map((unit) => [stem(byId.get(unit.primaryItemId).name), unit.id]));
    const resolve = (value) => unitByStem.get(value) || value;
    const predicted = new Set();
    for (const group of result.groups) {
      for (const left of group.unitIds) {
        for (const right of group.unitIds) if (left < right) predicted.add(`${left}|${right}`);
      }
    }
    const expected = new Set((labels.groups || []).flatMap((group) => {
      const ids = (group.unitIds || group).map(resolve);
      return ids.flatMap((left, i) => ids.slice(i + 1).map((right) => pair(left, right)));
    }));
    const uncertain = new Set((labels.uncertain || []).map(([left, right]) => pair(resolve(left), resolve(right))));
    const relevant = [...expected].filter((value) => !uncertain.has(value));
    const tp = relevant.filter((value) => predicted.has(value)).length;
    const fp = [...predicted].filter((value) => !relevant.includes(value)).length;
    const fn = relevant.length - tp;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
    t.diagnostic(JSON.stringify({ units: records.length, groups: result.groups.length, truePositives, falsePositives,
      maxGroupSize: Math.max(...result.groups.map((g) => g.unitIds.length)), tp, fp, fn, precision, recall, f1 }));
    assert.ok(f1 >= 0.88, `paired F1 ${f1.toFixed(3)} below W6 baseline`);
    assert.equal(fp, 0, "no false-positive pairs versus W6 baseline");
    assert.ok(tp >= 22 && fn <= 6, "pair recall must meet W6 baseline");
  });
