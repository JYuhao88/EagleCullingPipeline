import { replaceFile } from '../src/core/atomic-file.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { analyzeImage, normalizeMetrics } from '../src/core/metrics.js';
import { score } from '../src/core/scorer.js';
import { FaceWorkerPool, normalizeFaceResult } from '../src/core/faces.js';
import { PoseWorkerPool, detectPose } from '../src/core/pose.js';
import { computeSignals } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';
import { evaluateSynthetic, compareSynthetic } from '../ml/bench/evaluate.mjs';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const mode = process.argv[2];
if (!['cpu', 'dml'].includes(mode)) throw new Error('Usage: windows-bench.mjs cpu|dml [baseline.json]');
if (process.platform !== 'win32') throw new Error('Cold benchmark is restricted to Windows');
process.env.EAGLE_SCORER_PROVIDER = mode;
process.env.EAGLE_SCORER_THREADS = '2';
process.env.EAGLE_POSE_PROVIDER = mode === 'cpu' ? 'CPUExecutionProvider' : 'DmlExecutionProvider';
sharp.concurrency(1);
const manifestBytes = await readFile('test/fixtures/bench-syn-manifest.json');
const manifest = JSON.parse(manifestBytes);
const sources = ['src/core/scorer.js', 'src/core/metrics.js', 'src/core/signals.js', 'src/core/ranking.js',
  'src/core/rules-engine.js', 'python_worker/pose_worker.py', 'python_worker/pose_runtime.py',
  'python_worker/face_worker.py', 'scripts/windows-bench.mjs'];
const signature = hash(Buffer.concat([manifestBytes, ...await Promise.all(sources.map(file => readFile(file)))]));
const out = path.resolve('data/cache/windows-validation', mode, signature);
await mkdir(out, { recursive: true });
const faces = new FaceWorkerPool({ size: 1 });
const poses = new PoseWorkerPool({ size: 1 });
const results = [], start = performance.now();
let reused = 0;
try {
  for (const image of manifest.images) {
    const file = path.resolve('data/cache/bench/syn', image.path);
    if (!file.startsWith(path.resolve('data/cache/bench/syn') + path.sep)) throw new Error('Unsafe synthetic path');
    const sha256 = hash(await readFile(file));
    if (sha256 !== image.sha256) throw new Error(`Synthetic digest differs: ${image.id}`);
    const output = path.join(out, `${image.id}.json`);
    let row;
    try { row = await read(output); if (row.sha256 !== sha256) throw new Error('Stale cache'); reused++; }
    catch {
      const started = performance.now(), timing = {};
      const measured = await analyzeImage({ filePath: file, analysisPath: file });
      const scorer = (await score([file], { onTiming: value => Object.assign(timing, value) }))[0];
      if (!scorer.calibrated || scorer.quality === null) throw new Error(scorer.warning || 'Scorer unavailable');
      const face = normalizeFaceResult((await faces.run([{ id: image.id, filePath: file }]))[0]);
      if (face.warning || face.faces === null) throw new Error(face.warning || 'Face worker unavailable');
      const details = face.faceDetails || [];
      const pose = (await detectPose([{ id: image.id, filePath: file, faces: details }], { pool: poses }))[0];
      if (!pose.available || pose.provider !== process.env.EAGLE_POSE_PROVIDER) throw new Error('Pose provider mismatch');
      const signals = computeSignals(pose);
      row = { unitId: image.id, sha256, metrics: normalizeMetrics({ ...measured.metrics,
        quality: scorer.quality, aesthetic: scorer.aesthetic, faces: face.faces, eyesClosed: face.eyesClosed }),
      flags: [...new Set([...(measured.qualityFlags || []), ...(face.eyesClosed > 0 ? ['eyes-closed'] : [])])],
      scorer, faces: details, pose, signals, verdicts: evaluateRules(signals, { faces: details }),
      timing: { ...timing, totalMilliseconds: performance.now() - started } };
      await writeFile(`${output}.tmp`, JSON.stringify(row));
      await replaceFile(`${output}.tmp`, output);
    }
    results.push(row);
    if (results.length % 10 === 0) console.log(JSON.stringify({ mode, completed: results.length, reused }));
  }
  const synthetic = evaluateSynthetic(manifest, results);
  const report = { mode, signature, manifestSha256: hash(manifestBytes), images: results.length, reused,
    wallSeconds: (performance.now() - start) / 1000, synthetic,
    inferenceSeconds: results.reduce((sum, row) => sum + row.timing.totalMilliseconds, 0) / 1000,
    scorerInferenceSeconds: results.reduce((sum, row) => sum + row.timing.inferenceMilliseconds, 0) / 1000 };
  if (process.argv[3]) {
    const baseline = await read(process.argv[3]);
    if (baseline.manifestSha256 !== report.manifestSha256) throw new Error('Baseline manifest mismatch');
    report.comparison = compareSynthetic(baseline.synthetic, synthetic);
  }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.resolve('data/cache/windows-validation', `${mode}-latest.json`), JSON.stringify({ out, report }));
  console.log(JSON.stringify({ mode, out, images: results.length, seconds: report.inferenceSeconds }));
} finally { faces.close(); poses.close(); }
process.exit(0);
