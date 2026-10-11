import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(process.argv[4] ? path.join(process.argv[4], 'package.json') : import.meta.url);
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const dir = process.argv[2];
const target = process.argv[3];
const reference = JSON.parse(await readFile(path.join(dir, 'topiq_iaa_parity.json'), 'utf8'));
if (reference.rows.length < 20) throw new Error('need at least 20 reference images');
const start = performance.now();
const session = await ort.InferenceSession.create(path.join(dir, 'topiq_iaa_512.onnx'), {
  intraOpNumThreads: 3, interOpNumThreads: 1, executionProviders: ['cpu'],
});
const initMs = performance.now() - start;
async function tensor(file) {
  const preview = await sharp(file).rotate().removeAlpha().toColourspace('srgb')
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true, kernel: sharp.kernel.bilinear })
    .raw().toBuffer({ resolveWithObject: true });
  const { data } = await sharp(preview.data, { raw: preview.info })
    .resize(512, 512, { fit: 'fill', kernel: sharp.kernel.bilinear })
    .raw().toBuffer({ resolveWithObject: true });
  const plane = 512 * 512;
  const x = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    x[i] = data[i * 3] / 255;
    x[plane + i] = data[i * 3 + 1] / 255;
    x[2 * plane + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor('float32', x, [1, 3, 512, 512]);
}
const first = path.join(dir, `topiq_iaa_fixture_${reference.rows[0].id}.jpg`);
for (let i = 0; i < 3; i += 1) await session.run({ image: await tensor(first) });
const rows = [];
for (const row of reference.rows) {
  const file = path.join(dir, `topiq_iaa_fixture_${row.id}.jpg`);
  const begun = performance.now();
  const input = await tensor(file);
  const prepared = performance.now();
  const output = await session.run({ image: input });
  const ended = performance.now();
  const raw = Number(output.score.data[0]);
  rows.push({ id: row.id, raw, ray_pyiqa_preview_raw: row.pyiqa_preview_raw,
    raw_abs_diff: Math.abs(raw - row.pyiqa_preview_raw),
    preprocess_ms: prepared - begun, inference_ms: ended - prepared, total_ms: ended - begun });
}
function stats(field) {
  const x = rows.map(r => r[field]).sort((a, b) => a - b);
  const mid = Math.floor(x.length / 2);
  return { mean: x.reduce((a, b) => a + b, 0) / x.length,
    median: x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2, p95: x[Math.ceil(0.95 * x.length) - 1], max: x.at(-1) };
}
const result = { backend: 'onnxruntime-node', versions: ort.env.versions, niceness: os.getPriority(),
  threads: 3, inter_op_threads: 1, n: rows.length, init_ms: initMs, warmup: 3,
  preprocess: 'sharp EXIF RGB bilinear 768 preview -> stretch 512 /255; no external mean/std',
  inference_ms: stats('inference_ms'), total_ms: stats('total_ms'),
  ray_pyiqa_mean_abs_diff_raw: rows.reduce((sum, r) => sum + r.raw_abs_diff, 0) / rows.length, rows };
result.ray_pyiqa_mean_abs_diff_unit = result.ray_pyiqa_mean_abs_diff_raw / 9;
result.latency_pass = result.total_ms.max <= 400;
result.parity_pass = result.ray_pyiqa_mean_abs_diff_raw < 0.02;
await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, rows: undefined }));
