import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { readManifest, readRows } from '../src/core/segmented-results.js';
import { observationModelPath } from '../src/core/observation-head.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const runId = option('--run');
if (!runId || !/^[\w-]+$/.test(runId)) throw new Error('需要 --run <已有小任务 ID>');
const root = path.resolve(option('--root', '.'));
const cacheRoot = path.resolve(option('--cache-dir', 'data/cache/observe-runtime/benchmark'));
const encoder = option('--encoder', 'clip-b32-q');
if (!['clip-b32-q', 'dinov2-small'].includes(encoder)) throw new Error('未知 encoder');
const directory = path.join(root, 'data', 'runs', runId), manifest = await readManifest(directory);
const rows = manifest ? readRows(directory, manifest, 'results')
  : JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')).results;
const selected = [];
for await (const row of rows) {
  if (row.previewPath && row.faces?.length) selected.push(row);
  if (selected.length === 3) break;
}
if (!selected.length) throw new Error('小任务没有带预览和人脸的单元');
const records = selected.map(row => ({ unitId: row.unitId, analysisPath: row.previewPath, name: row.name,
  captureTime: row.captureTime, sessionId: row.sessionId, exif: {}, width: row.source?.width, height: row.source?.height }));
const fixturePath = path.join(root, 'test', 'fixtures', 'observation-head.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const size = encoder === 'clip-b32-q' ? 512 : 384;
fixture.encoder = { id: encoder, dimensions: size,
  modelSha256: createHash('sha256').update(await readFile(observationModelPath(root, encoder))).digest('hex') };
fixture.version = 'benchmark-fake-v1';
for (const attribute of fixture.attributes) {
  attribute.weights = [2, ...Array(size - 1).fill(0)];
  attribute.normalization = { mean: [1, ...Array(size - 1).fill(0)], scale: [2, ...Array(size - 1).fill(1)] };
  attribute.showThreshold = .55;
}
const headDir = path.join(cacheRoot, 'heads'), emptyDir = path.join(cacheRoot, 'empty-heads');
await mkdir(headDir, { recursive: true }); await mkdir(emptyDir, { recursive: true });
await writeFile(path.join(headDir, 'benchmark.json'), JSON.stringify(fixture));

async function run(label, enabled, nativeFocus = false) {
  let index = 0;
  const pipeline = new AnalysisPipeline({ root, cacheRoot, concurrency: 1,
    observationHeadDir: enabled ? headDir : emptyDir,
    store: { get: async fingerprint => ({ ...structuredClone(selected[index++]), fingerprint }), put: async () => {} },
    faceDetector: async () => [], poseDetector: async () => [] });
  const start = performance.now();
  const data = await pipeline.run(structuredClone(records), { nativeFocus, performanceMode: 'normal' });
  return { data, sample: { label, wallMs: performance.now() - start, observationTimingMs: data.observationTimingMs || null,
    itemCount: data.results.reduce((sum, row) => sum + (row.observations?.items?.length || 0), 0) } };
}

// Existing analysis/model caches are retained; only this benchmark's observation/focus subdirectories are reset.
await rm(path.join(cacheRoot, 'observations'), { recursive: true, force: true });
await run('prime-existing-stages', false);
const baseline = await run('disabled', false);
const cold = await run('enabled-cold', true);
const warm = await run('enabled-warm', true);
await rm(path.join(cacheRoot, 'observations'), { recursive: true, force: true });
await rm(path.join(cacheRoot, 'focus'), { recursive: true, force: true });
const reuse = await run('focus-native-reuse', true, true);
const equalGroups = JSON.stringify(baseline.data.groups) === JSON.stringify(cold.data.groups);
const report = { runId, units: records.length, encoder, input: fixture.input, fakeHead: true,
  scope: '复用历史指标，真实本地编码器；冷/热观察比较跳过已分析 focus，另测 focus 像素复用',
  equalGroups, samples: [baseline.sample, cold.sample, warm.sample, reuse.sample],
  coldAddedWallMs: cold.sample.wallMs - baseline.sample.wallMs,
  warmAddedWallMs: warm.sample.wallMs - baseline.sample.wallMs };
await writeFile(path.join(cacheRoot, 'report.json'), JSON.stringify(report, null, 2));
await rm(headDir, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
if (!equalGroups) throw new Error('观察改变了分组或排序');
if (warm.sample.observationTimingMs.cacheHits !== records.length) throw new Error('热观察缓存没有命中');
