import { requireLocalSetting } from '../src/core/local-config.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { score } from "../src/core/scorer.js";

const fixture = requireLocalSetting('ECP_SCORER_FIXTURE');
const referencePath = path.join(path.dirname(new URL(import.meta.url).pathname), "scorer-reference.json");
const supported = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const writeReference = process.argv.includes("--write-reference");
const average = (values) => values.length
  ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;

async function main() {
  const photoDir = path.join(fixture, "photos");
  const names = await readdir(photoDir);
  const paths = names.map((name) => path.join(photoDir, name))
    .filter((file) => supported.has(path.extname(file).toLowerCase())).slice(0, 10);
  const rows = [];
  const skipped = [];
  for (const file of paths) {
    if (path.extname(file).toLowerCase() === ".heic") {
      try { await sharp(file).rotate().raw().toBuffer(); }
      catch { skipped.push(`${file}（sharp 无法读取）`); continue; }
    }
    const timings = [];
    try {
      const started = performance.now();
      const result = (await score([file], {
        root: process.cwd(), onTiming: (timing) => timings.push(timing),
      }))[0];
      rows.push({ path: file, quality: result.quality,
        milliseconds: Number((performance.now() - started).toFixed(1)),
        decodeMilliseconds: timings[0]?.decodeMilliseconds ?? null,
        inferenceMilliseconds: timings[0]?.inferenceMilliseconds ?? null,
        warning: result.warning || null });
    } catch (error) {
      if (path.extname(file).toLowerCase() === ".heic") skipped.push(`${file}（sharp 无法读取）`);
      else throw error;
    }
  }
  const references = writeReference ? {} : JSON.parse(await readFile(referencePath, "utf8"));
  if (writeReference) {
    for (const row of rows) references[path.basename(row.path)] = row.quality;
    await writeFile(referencePath, `${JSON.stringify(references, null, 2)}\n`);
  }
  const differences = rows.map((row) => [row.quality, references[path.basename(row.path)]])
    .filter(([actual, expected]) => Number.isFinite(actual) && Number.isFinite(expected))
    .map(([actual, expected]) => Math.abs(actual - expected));
  const valid = rows.map((row) => row.quality).filter(Number.isFinite);
  const mean = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
  const standardDeviation = valid.length
    ? Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length) : 0;
  const temp = await mkdtemp(path.join(os.tmpdir(), "eagle-scorer-preview-"));
  const previewRows = [];
  try {
    for (const file of rows.map((row) => row.path)) {
      const output = path.join(temp, `${path.basename(file)}.jpg`);
      try {
        await sharp(file, { failOn: "none" }).rotate().resize(768, 768, { fit: "inside" }).jpeg().toFile(output);
        const started = performance.now();
        const timings = [];
        await score([output], { root: process.cwd(), onTiming: (timing) => timings.push(timing) });
        previewRows.push({ path: file, milliseconds: Number((performance.now() - started).toFixed(1)), ...timings[0] });
      } catch (error) {
        if (path.extname(file).toLowerCase() === ".heic") skipped.push(`${file}（sharp 无法读取）`);
        else throw error;
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  const previewInference = previewRows.map((row) => row.inferenceMilliseconds).filter(Number.isFinite);
  const meanAbsoluteDifference = differences.length
    ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null;
  const checks = {
    validCount: valid.length, meanAbsoluteDifference,
    rangeValid: valid.every((value) => value > 0.05 && value < 0.98),
    standardDeviation: Number(standardDeviation.toFixed(6)), variationValid: standardDeviation > 0.005,
    averagePreviewInferenceMilliseconds: average(previewInference),
  };
  const failed = checks.validCount === 0 || !checks.rangeValid || !checks.variationValid ||
    (meanAbsoluteDifference !== null && meanAbsoluteDifference > 0.01);
  console.log(JSON.stringify({ model: "topiq-nr-onnx", count: rows.length, checks,
    timing: { averageDecodePreprocessMilliseconds: average(rows.map((row) => row.decodeMilliseconds).filter(Number.isFinite)),
      averageInferenceMilliseconds: average(rows.map((row) => row.inferenceMilliseconds).filter(Number.isFinite)),
      preview768LongEdgeAverageMilliseconds: average(previewRows.map((row) => row.milliseconds)) },
    heicSkipped: skipped, rows }, null, 2));
  if (failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
