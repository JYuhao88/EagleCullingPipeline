#!/usr/bin/env node
// Bounded Windows-only observation encoder probe. It uses Open Images face crops only.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { observationsFromVector } from '../src/core/observation-head.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const provider = option('--provider', process.env.EAGLE_CLIP_PROVIDER || 'cpu');
const model = path.resolve(option('--model', 'models/clip/vision_model_quantized.onnx'));
const faceDir = path.resolve(option('--face-dir', 'data/cache/w34-wingpu/face'));
const output = path.resolve(option('--output', `data/cache/w34-wingpu/${provider}.json`));
const comparePath = option('--compare');
const headPath = option('--head', 'src/core/observation-heads/clip-face-v1.json');
const encoder = option('--encoder', 'clip-b32-q');
const size = Number(option('--size', encoder === 'siglip2-base' ? 224 : 224));
const maxCount = Math.max(1, Number(option('--count', 786)));
const warmSkip = Math.max(0, Number(option('--warm-skip', 3)));
const optimization = option('--optimization', 'all');

const digestFile = async file => {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const cosine = (a, b) => {
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return dot / Math.sqrt(Math.max(1e-12, an * bn));
};
const modelInput = async file => {
  const prep = encoder === 'siglip2-base'
    ? { mean: [.5, .5, .5], std: [.5, .5, .5] }
    : { mean: [.48145466, .4578275, .40821073], std: [.26862954, .26130258, .27577711] };
  const { data } = await sharp(file).rotate().resize(size, size, { fit: 'cover', kernel: 'cubic' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = size * size, input = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++)
    input[c * pixels + i] = (data[3 * i + c] / 255 - prep.mean[c]) / prep.std[c];
  return new ort.Tensor('float32', input, [1, 3, size, size]);
};
const normalized = tensor => {
  const values = Array.from(tensor.data, Number);
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return values.map(value => value / norm);
};

const names = (await readdir(faceDir)).filter(name => /\.jpg$/i.test(name)).sort().slice(0, maxCount);
if (!names.length) throw new Error(`没有找到脸裁剪: ${faceDir}`);
const options = { executionProviders: [provider], intraOpNumThreads: 2, interOpNumThreads: 1,
  executionMode: 'sequential', ...(optimization !== 'all' ? { graphOptimizationLevel: optimization } : {}),
  ...(provider === 'dml' ? { enableMemPattern: false } : {}) };
const report = { status: 'running', encoder, provider, model, modelSha256: await digestFile(model), count: names.length,
  input: { size, mean: encoder === 'siglip2-base' ? [.5, .5, .5] : [.48145466, .4578275, .40821073],
    std: encoder === 'siglip2-base' ? [.5, .5, .5] : [.26862954, .26130258, .27577711] } };
try {
  const loadStarted = performance.now();
  const session = await ort.InferenceSession.create(model, options);
  report.firstLoadMs = performance.now() - loadStarted;
  report.session = { inputs: session.inputNames, outputs: session.outputNames, options };
  const latencies = [], vectors = [], decisions = [], gpuSamples = [];
  const head = encoder === 'clip-b32-q' ? JSON.parse(await readFile(headPath, 'utf8')) : null;
  const prepStarted = performance.now();
  for (let index = 0; index < names.length; index++) {
    const input = await modelInput(path.join(faceDir, names[index]));
    const started = performance.now();
    const result = await session.run({ [session.inputNames[0]]: input });
    const elapsed = performance.now() - started;
    if (index >= warmSkip) latencies.push(elapsed);
    const tensor = result.image_embeds || result.pooler_output || result[session.outputNames[0]];
    const vector = normalized(tensor);
    vectors.push(vector);
    if (head) decisions.push(observationsFromVector(vector, head, { box: [0, 0, 1, 1] }).map(row => row.id).sort());
    if (index % 8 === 0) {
      try {
        const query = ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'];
        const line = execFileSync('nvidia-smi', query, { encoding: 'utf8' }).trim();
        const [memory, utilization] = line.split(',').map(value => Number(value.trim()));
        if (Number.isFinite(memory) && Number.isFinite(utilization)) gpuSamples.push({ memoryMiB: memory, utilization });
      } catch { /* Resource sampling is observational and must not fail inference. */ }
    }
  }
  report.preprocessAndRunMs = performance.now() - prepStarted;
  report.warmLatencyMs = { count: latencies.length, mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50: percentile(latencies, .5), p95: percentile(latencies, .95), min: Math.min(...latencies), max: Math.max(...latencies) };
  const peak = key => (gpuSamples.length ? Math.max(...gpuSamples.map(row => row[key])) : null);
  report.gpuSamples = { count: gpuSamples.length, memoryPeakMiB: peak('memoryMiB'), utilizationPeak: peak('utilization') };
  report.vectors = vectors;
  if (decisions.length) report.decisions = decisions;
  report.status = 'ok';
  if (comparePath) {
    const baseline = JSON.parse(await readFile(path.resolve(comparePath), 'utf8'));
    if (baseline.status !== 'ok' || baseline.vectors?.length !== vectors.length) throw new Error('基线向量数量不一致');
    const cosines = vectors.map((vector, i) => cosine(vector, baseline.vectors[i]));
    report.parity = { baselineProvider: baseline.provider, cosineMin: Math.min(...cosines),
      cosineMean: cosines.reduce((a, b) => a + b, 0) / cosines.length,
      cosineP01: percentile(cosines, .01), changedDecisions: null };
    if (decisions.length && baseline.decisions?.length === decisions.length) {
      let changed = 0;
      for (let i = 0; i < decisions.length; i++) if (JSON.stringify(decisions[i]) !== JSON.stringify(baseline.decisions[i])) changed++;
      report.parity.changedDecisions = changed;
    }
  }
} catch (error) {
  report.status = 'error'; report.error = String(error?.stack || error);
  report.firstLoadMs ??= null;
  process.exitCode = 1;
}
await writeFile(output, JSON.stringify(report));
console.log(JSON.stringify({ ...report, vectors: undefined }));
