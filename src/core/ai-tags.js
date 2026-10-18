import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { touchCache } from './cache-budget.js';
import { measurementPoints, SIGNAL_THRESHOLDS } from './signals.js';

const require = createRequire(import.meta.url);
const sessions = new Map();
const defaultModel = fileURLToPath(new URL('../../models/clip/vision_model_quantized.onnx', import.meta.url));
const defaultCache = fileURLToPath(new URL('../../data/cache/ai-tags/', import.meta.url));
let vocabulary;
const digest = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function deriveTags(result = {}, item = {}) {
  const tags = [];
  const add = name => tags.push({ tag: `AI·${name}`, source: 'derived' });
  const persons = result.signals?.persons ?? result.pose?.persons;
  const count = Array.isArray(persons) ? persons.length
    : Array.isArray(result.faces) ? result.faces.length : result.metrics?.faces;
  if (Number.isInteger(count) && count >= 0) add(['无人', '单人', '双人'][count] || '多人');
  const width = positive(result.source?.width ?? item.width ?? result.signals?.source?.width);
  const height = positive(result.source?.height ?? item.height ?? result.signals?.source?.height);
  if (width && height) add(width === height ? '方构图' : width > height ? '横构图' : '竖构图');
  if (count > 0 && persons?.length) {
    const main = persons.find(person => person.isMain) || [...persons].sort((a, b) => {
      const area = p => p.box ? (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]) : 0;
      return area(b) - area(a);
    })[0];
    const points = measurementPoints(main, width && height ? width / height : 1);
    const visible = index => {
      const p = points[index];
      return p?.length >= 3 && p.every(Number.isFinite) && p[2] >= SIGNAL_THRESHOLDS.confidence &&
        p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
    };
    if (main.framingTier === 'full' || [15, 16].every(visible)) add('全身');
    else if (['waist', 'thigh', 'knee-cut'].includes(main.framingTier) || [11, 12].every(visible)) add('半身');
    else if (main.framingTier === 'chest' || [0, 5, 6].every(visible) && ![7, 8, 9, 10, 11, 12, 13, 14].some(visible))
      add('特写');
  }
  const names = { blurry: '模糊', overexposed: '过曝', underexposed: '欠曝', 'eyes-closed': '闭眼' };
  for (const flag of new Set(result.flags || [])) if (names[flag]) add(names[flag]);
  const exif = { ...item.exif, ...result.exif };
  const focal = positive(exif.focalLength35mm ?? exif.FocalLengthIn35mmFormat ?? exif.FocalLengthIn35mmFilm)
    || positive(exif.focalLength ?? exif.FocalLength);
  if (focal) add(focal < 35 ? '广角' : focal <= 70 ? '标准' : '长焦');
  return tags;
}

export function selectSceneTags(vector, catalog, { maxTags = catalog.maxTags ?? 3 } = {}) {
  if (!vector?.length || vector.length !== catalog.dimensions || !Array.from(vector).every(Number.isFinite)) return [];
  const norm = Math.hypot(...vector);
  if (!norm) return [];
  return catalog.labels.flatMap(label => {
    if (label.vector?.length !== vector.length || !label.vector.every(Number.isFinite)) return [];
    const score = label.vector.reduce((sum, value, index) => sum + value * vector[index] / norm, 0);
    return score >= label.threshold ? [{ tag: label.tag, source: 'scene', score }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(3, Math.trunc(maxTags))));
}

export function sceneCacheKey({ modelVersion, modelIdentity, fingerprint, vocabularyHash }) {
  return digest(JSON.stringify(['ai-tags-v1', modelVersion, modelIdentity, fingerprint, vocabularyHash]));
}

export async function clipImageVector(file, model, catalog = {}, signal) {
  const prep = catalog.preprocess || {};
  const size = prep.size || 224;
  const { data } = await sharp(file).rotate().resize(size, size, { fit: 'cover', kernel: 'cubic' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  const mean = prep.mean || [0.48145466, 0.4578275, 0.40821073];
  const std = prep.std || [0.26862954, 0.26130258, 0.27577711];
  const pixels = size * size, input = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++)
    input[c * pixels + i] = (data[3 * i + c] / 255 - mean[c]) / std[c];
  const ort = require('onnxruntime-node');
  const info = await stat(model);
  const sessionKey = JSON.stringify([path.resolve(model), info.size, info.mtimeMs]);
  if (!sessions.has(sessionKey)) {
    const session = ort.InferenceSession.create(model, { intraOpNumThreads: 2, interOpNumThreads: 1,
      executionProviders: ['cpu'], executionMode: 'sequential' });
    sessions.set(sessionKey, session);
    session.catch(() => sessions.delete(sessionKey));
  }
  const session = await sessions.get(sessionKey);
  signal?.throwIfAborted();
  const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
  signal?.throwIfAborted();
  return outputs.image_embeds?.data ?? outputs[session.outputNames[0]].data;
}

export async function sceneTags(previewPath, { model = defaultModel, cacheDir = defaultCache,
  fingerprint, signal, catalog, infer = clipImageVector } = {}) {
  signal?.throwIfAborted();
  if (!previewPath) return [];
  try {
    await access(model);
    catalog ??= vocabulary ??= JSON.parse(await readFile(new URL('./scene-tags.json', import.meta.url), 'utf8'));
    const [modelInfo, imageInfo] = await Promise.all([stat(model), stat(previewPath)]);
    const key = sceneCacheKey({ modelVersion: catalog.version,
      modelIdentity: [path.resolve(model), modelInfo.size, modelInfo.mtimeMs],
      fingerprint: [fingerprint || '', path.resolve(previewPath), imageInfo.size, imageInfo.mtimeMs],
      vocabularyHash: digest(JSON.stringify(catalog)) });
    const cachePath = path.join(cacheDir, `${key}.json`);
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      if (cached.key === key && Array.isArray(cached.tags) && cached.tags.length <= 3 && cached.tags.every(row =>
        row.source === 'scene' && Number.isFinite(row.score) && catalog.labels.some(label =>
          label.tag === row.tag && row.score >= label.threshold))) {
        await touchCache(cachePath);
        signal?.throwIfAborted();
        return cached.tags;
      }
    } catch { signal?.throwIfAborted(); }
    const vector = await infer(previewPath, model, catalog, signal);
    signal?.throwIfAborted();
    const tags = selectSceneTags(vector, catalog);
    try {
      await mkdir(cacheDir, { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ key, tags }));
      await rename(temporary, cachePath);
    } catch { /* Cache failures must not discard local inference. */ }
    return tags;
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}
