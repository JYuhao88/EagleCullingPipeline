#!/usr/bin/env node
import { localSetting } from './core/local-config.js';
import path from "node:path";
import { restartService, candidateService } from "./server/update-restart.js";
import { access, writeFile } from "node:fs/promises";
import { createAnalysisServer } from "./server.js";
import { DecisionsStore } from "./core/decisions-store.js";
import {
  planWriteback, applyWriteback, withLiveTags, planRevertWriteback,
  validateRevertRecords, writebackRecords, revertedRecords
} from "./core/writeback.js";
import { buildReport, reportCsv, reportJson } from "./core/report.js";
import { EagleApi } from "./core/eagle-api.js";
import { listEagleImages } from "./core/metrics.js";
import { AnalysisPipeline } from "./core/pipeline.js";
import { ResultsStore } from "./core/results-store.js";
import { buildCaptureUnits } from "./core/capture-units.js";
import { RunStore } from "./server/run-store.js";
import { restoreThumbnails } from "./core/restore-thumbnails.js";
import { execFile } from "node:child_process";
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const flag = (name) => process.argv.includes(name);
async function doctor() {
  const checks = {};
  try {
    const api = new EagleApi();
    await api.libraryInfo();
    checks.eagle = true;
  } catch {
    checks.eagle = false;
  }
  const library = arg("--library", localSetting("EAGLE_LIBRARY_PATH"));
  checks.library = Boolean(library);
  checks.sips = process.platform !== "darwin";
  try {
    await new Promise((resolve, reject) =>
      execFile("sips", ["--version"], (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    checks.sips = true;
  } catch {}
  try {
    await import("sharp");
    checks.sharp = true;
  } catch {
    checks.sharp = false;
  }
  try {
    await new Promise((resolve, reject) => execFile(localSetting("EAGLE_EXIFTOOL", "exiftool"), ["-ver"],
      { timeout: 5000 }, error => error ? reject(error) : resolve()));
    checks.exiftool = true;
  } catch { checks.exiftool = false; }
  const python = localSetting("EAGLE_PYTHON", process.platform === "win32"
    ? "python_worker/.venv/Scripts/python.exe" : "python_worker/.venv/bin/python");
  try {
    await new Promise((resolve, reject) => execFile(python, ["--version"], error => error ? reject(error) : resolve()));
    checks.python = true;
  } catch {
    checks.python = false;
  }
  try {
    await new Promise((resolve, reject) => execFile(python, ["-c", "import mediapipe"],
      error => error ? reject(error) : resolve()));
    checks.mediapipe = true;
  } catch {
    checks.mediapipe = false;
  }
  try {
    await access("models/mediapipe/face_landmarker.task");
    checks.faceModel = true;
  } catch {
    checks.faceModel = false;
  }
  try {
    await access("models/dinov2-small/model.onnx");
    checks.dinoModel = true;
  } catch {
    checks.dinoModel = false;
  }
  console.log(
    JSON.stringify({ ok: checks.eagle && checks.library, checks }, null, 2),
  );
}
async function analyze() {
  const libraryPath = arg("--library", localSetting("EAGLE_LIBRARY_PATH"));
  if (!libraryPath) throw new Error("--library is required");
  const items = await listEagleImages(path.resolve(libraryPath));
  const units = buildCaptureUnits(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const records = units.map((unit) => ({
    ...byId.get(unit.primaryItemId),
    unitId: unit.id,
    itemIds: unit.itemIds,
  }));
  const runStore = new RunStore();
  const id = `run-${Date.now()}`;
  const pipeline = new AnalysisPipeline({
    concurrency: Number(arg("--concurrency", 2)) || 2,
    store: new ResultsStore(),
  });
  const started = Date.now();
  const result = await pipeline.run(records, {
    id,
    onProgress: (progress) => {
      if (progress.completed === progress.total)
        console.error(`分析完成 ${progress.completed}/${progress.total}`);
    },
  });
  const run = {
    contractVersion: 1,
    id,
    status: "completed",
    libraryPath,
    itemCount: items.length,
    unitCount: units.length,
    groupCount: result.groups.length,
    progress: result.progress,
    warnings: result.warnings || [],
    elapsedMs: Date.now() - started,
    results: result,
  };
  await runStore.save(run, {
    run,
    units,
    items,
    results: result.results,
    groups: result.groups,
  });
  const output = arg("--out");
  if (output)
    await (
      await import("node:fs/promises")
    ).writeFile(output, JSON.stringify(run, null, 2));
  const sizes = result.groups.reduce((map, group) => {
    const size = group.unitIds.length;
    map[size] = (map[size] || 0) + 1;
    return map;
  }, {});
  const faces = result.results.filter(
    (entry) => (entry.metrics?.faces || 0) > 0,
  ).length;
  const closed = result.results.filter(
    (entry) => (entry.metrics?.eyesClosed || 0) > 0,
  ).length;
  console.log(
    `分析完成：${items.length} 个文件，${units.length} 个单元，${result.groups.length} 组`,
  );
  console.log(
    `组大小分布：${JSON.stringify(sizes)}；人脸单元 ${faces}，闭眼单元 ${closed}`,
  );
  console.log(
    `耗时 ${run.elapsedMs} ms；缓存命中 ${result.progress.cached}；run ${id}`,
  );
}
async function restore() {
  const file = arg("--ids-file");
  const library = arg("--library");
  if (!file || !library)
    throw new Error("--ids-file and --library are required");
  const { readFile } = await import("node:fs/promises");
  const ids = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  const api = new EagleApi({ expectedLibraryPath: library });
  console.log(
    JSON.stringify(
      await restoreThumbnails(api, ids, {
        apply: flag("--apply"),
        confirm: arg("--confirm", ""),
      }),
      null,
      2,
    ),
  );
}
async function serve() {
  const port = Number(arg("--port", process.env.CULLING_PORT || 43125));
  const pipeline = new AnalysisPipeline({
    concurrency: Number(arg("--concurrency", 2)) || 2, store: new ResultsStore()
  });
  const server = createAnalysisServer({ port, pipeline });
  server.updater.restart = restartService(server, { port });
  if (!(await candidateService(server))) await server.listen();
  console.log(`Eagle 照片筛选服务：http://127.0.0.1:${port}`);
}
async function loadRun(runId) {
  const runStore = new RunStore();
  const data = await runStore.get(runId);
  if (!data) throw new Error(`run not found: ${runId}`);
  return { ...data, dir: runStore.dir(runId) };
}
async function effectiveDecisions(data) {
  return new DecisionsStore(data.dir).effective(data.results, data.groups);
}
async function report() {
  const runId = arg("--run");
  if (!runId) throw new Error("--run is required");
  const data = await loadRun(runId);
  const rows = buildReport({ ...data, decisions: await effectiveDecisions(data) });
  const format = arg("--format", "json");
  const output = format === "csv" ? reportCsv(rows) : reportJson(rows);
  const destination = arg("--out");
  if (destination) await writeFile(destination, output, "utf8");
  else process.stdout.write(format === "csv" ? output : `${output}\n`);
}
async function apply() {
  const runId = arg("--run");
  if (!runId) throw new Error("--run is required");
  const data = await loadRun(runId);
  const api = new EagleApi({ expectedLibraryPath: data.run?.libraryPath });
  const execute = flag("--apply");
  const revert = flag("--revert");
  if (revert && flag("--move-rejected-to-trash")) throw new Error("撤回不可同时移入废纸篓");
  if (revert) validateRevertRecords(data.applied);
  await api.assertLibrary();
  const targets = revert ? data.applied.map(record => ({ id: record.id, name: record.fileName })) : data.items;
  const { items } = await withLiveTags(targets, api, { requireTags: true });
  const plan = revert ? planRevertWriteback({ applied: data.applied, items })
    : planWriteback({ ...data, items, decisions: await effectiveDecisions(data) });
  const result = await applyWriteback(plan, api, { apply: execute });
  if (execute) {
    const records = revert ? revertedRecords(data.applied, result) : writebackRecords(plan, result);
    await new RunStore().saveApplied(data.run.id, records);
  }
  if (flag("--move-rejected-to-trash")) {
    if (arg("--confirm", "") !== "MOVE_TO_TRASH") {
      throw new Error("--move-rejected-to-trash requires --confirm MOVE_TO_TRASH");
    }
    const ids = plan.items.filter((item) => item.action === "rejected").map((item) => item.id);
    result.trash = execute ? await api.moveToTrash(ids) : { dryRun: true, ids };
  }
  if (revert) result.revert = true;
  console.log(JSON.stringify(result, null, 2));
}
const command = process.argv[2];
const commands = {
  doctor,
  analyze,
  serve,
  report,
  apply,
  "restore-thumbnails": restore,
};
if (!commands[command]) {
  console.error(
    "Usage: node src/cli.js doctor|analyze|serve|report|apply|restore-thumbnails",
  );
  process.exitCode = 2;
} else
  commands[command]().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
