import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { touchCache } from './cache-budget.js';
import { replaceFile } from './atomic-file.js';
import { nativeFingerprint, withNativeImage } from './native-image.js';
import { faceTooSmall, observationCacheKey, observationsFromVector } from './observation-head.js';
import { observationBox, validObservation } from './observations.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const area = box => (box[2] - box[0]) * (box[3] - box[1]);

export function observationFace(result) {
  const faces = (result.faces || []).filter(face => observationBox(face?.box));
  const main = (result.signals?.persons || []).find(person => person.isMain && observationBox(person.box));
  if (!main) return [...faces].sort((a, b) => area(b.box) - area(a.box))[0] || null;
  const candidates = faces.filter(face => {
    const b = face.box, p = main.box;
    const overlap = Math.max(0, Math.min(b[2], p[2]) - Math.max(b[0], p[0]))
      * Math.max(0, Math.min(b[3], p[3]) - Math.max(b[1], p[1]));
    return overlap / area(b) > 0.5;
  });
  // Ambiguous subject-to-face matches abstain instead of attributing a bystander's expression.
  return candidates.length === 1 ? candidates[0] : null;
}

// The teacher crops were shifted inside the frame rather than padded; heads see the same framing here.
export function observationCropRect(box, { width, height }) {
  if (!observationBox(box) || !(width > 0 && height > 0)) return null;
  const side = Math.floor(Math.min(width, height, 1.8 * Math.max((box[2] - box[0]) * width, (box[3] - box[1]) * height)));
  if (side < 1) return null;
  const left = Math.round(Math.min(width - side, Math.max(0, (box[0] + box[2]) / 2 * width - side / 2)));
  const top = Math.round(Math.min(height - side, Math.max(0, (box[1] + box[3]) / 2 * height - side / 2)));
  return { rect: { left, top, width: side, height: side }, side };
}

export async function observationFaceCrop(image, source, box) {
  const crop = observationCropRect(box, source);
  if (!crop) return null;
  return image().extract(crop.rect).resize(384, 384, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('srgb').removeAlpha().png().toBuffer();
}

export async function observationFeatureVector(file, entry, signal, components = new Map(), dependencies = {}) {
  signal?.throwIfAborted();
  if (entry.head.encoder.id === 'dinov2-small') {
    const { dinoImageVector } = dependencies.dinoImageVector ? dependencies : await import('./embeddings.js');
    const vector = await dinoImageVector(file, entry.model, signal);
    signal?.throwIfAborted();
    return vector;
  }
  const gaze = entry.head.encoder.id === 'mediapipe-iris-pose-q2-clip-b32-q';
  let geometry;
  if (gaze) {
    const { gazeGeometryVector } = dependencies.gazeGeometryVector ? dependencies : await import('./gaze-geometry.js');
    geometry = await gazeGeometryVector(file, entry.model, { modelSha256: entry.head.encoder.modelSha256 }, signal);
    signal?.throwIfAborted();
    if (!geometry || geometry.length !== 228 || !Array.from(geometry).every(Number.isFinite)) return null;
  }
  const model = gaze ? entry.clipModel : entry.model;
  const key = digest(['clip-b32-q', path.resolve(file), path.resolve(model),
    gaze ? entry.head.encoder.clipModelSha256 : entry.head.encoder.modelSha256]);
  if (!components.has(key)) {
    const { clipImageVector } = dependencies.clipImageVector ? dependencies : await import('./ai-tags.js');
    const vector = await clipImageVector(file, model, {}, signal);
    signal?.throwIfAborted();
    const finite = vector?.length === 512 && Array.from(vector).every(Number.isFinite);
    const norm = finite ? Math.hypot(...vector) : 0;
    components.set(key, norm && Number.isFinite(norm) ? Array.from(vector, value => value / norm) : null);
  }
  signal?.throwIfAborted();
  const clip = components.get(key);
  return clip && (gaze ? [...geometry, ...clip] : clip);
}

async function publish(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data); await replaceFile(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export class ObservationRuntime {
  constructor(heads, { cacheDir, signal, infer = observationFeatureVector } = {}) {
    this.heads = heads;
    this.cacheDir = cacheDir;
    this.signal = signal;
    this.infer = infer;
    this.plans = new Map();
    this.version = `observations-v1-${digest(heads.map(entry => [entry.head.version, entry.hash]))}`;
    this.timing = { prepareMs: 0, cropMs: 0, inferenceMs: 0, reusedNativeCropMs: 0, reusedNativeCrops: 0, cacheHits: 0 };
  }

  async prepare(result, record) {
    const start = performance.now();
    this.signal?.throwIfAborted();
    const faceBox = observationFace(result)?.box;
    const nativeRecord = { ...record, filePath: result.sourcePath || record.filePath };
    const generated = result.previewPath && path.dirname(path.resolve(result.previewPath))
      === path.resolve(this.cacheDir, '..', 'previews');
    const sourceIdentity = await nativeFingerprint(nativeRecord, [...(record.pairedItems || []),
      ...(generated ? [] : [{ filePath: result.previewPath }])]);
    // Generated previews are content-addressed; LRU touches must not invalidate observations on every run.
    if (generated) sourceIdentity.push(['preview', path.basename(result.previewPath)]);
    const entries = [];
    for (const entry of this.heads) {
      const key = observationCacheKey({ fingerprint: result.fingerprint, version: entry.head.version,
        encoderSha: entry.head.encoder.modelSha256, input: entry.head.input, headHash: entry.hash,
        faceBox: entry.head.input.type === 'face-crop' ? faceBox : undefined, sourceIdentity });
      const file = path.join(this.cacheDir, `${key}.json`);
      let items = null;
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (cached.key === key && Array.isArray(cached.items) && cached.items.every(item =>
          validObservation(item) && item.source === 'model' && entry.head.attributes.some(attribute =>
            attribute.id === item.id && item.confidence >= attribute.showThreshold
            && [attribute.positive, attribute.negative].some(label => label?.text === item.text && label.tone === item.tone)))) {
          items = cached.items;
          await touchCache(file);
          this.timing.cacheHits++;
        }
      } catch { this.signal?.throwIfAborted(); }
      entries.push({ ...entry, key, file, items });
    }
    const cropFile = path.join(this.cacheDir, 'crops',
      `${digest([result.fingerprint, faceBox, sourceIdentity, 'face-1.8-384-shift'])}.png`);
    const plan = { entries, faceBox, nativeRecord, cropFile, needsCrop: faceBox
      && entries.some(entry => entry.items === null && entry.head.input.type === 'face-crop'
        && !faceTooSmall(entry.head, faceBox)) };
    plan.cropReady = false;
    if (plan.needsCrop) {
      try {
        await access(cropFile);
        const meta = await sharp(cropFile).metadata();
        plan.cropReady = meta.width === 384 && meta.height === 384 && meta.format === 'png';
      } catch { this.signal?.throwIfAborted(); }
    }
    this.plans.set(result.unitId, plan);
    this.timing.prepareMs += performance.now() - start;
  }

  async capture(result, image, source) {
    const plan = this.plans.get(result.unitId);
    if (!plan?.needsCrop || plan.cropReady) return false;
    const start = performance.now();
    this.signal?.throwIfAborted();
    const crop = await observationFaceCrop(image, source, plan.faceBox);
    this.signal?.throwIfAborted();
    await publish(plan.cropFile, crop);
    plan.cropReady = true;
    this.timing.cropMs += performance.now() - start;
    return true;
  }

  async analyze(result, record) {
    const plan = this.plans.get(result.unitId);
    this.signal?.throwIfAborted();
    if (plan.needsCrop && !plan.cropReady) {
      try {
        await withNativeImage(plan.nativeRecord, { pairedItems: record.pairedItems, signal: this.signal },
          async ({ image, source }) => this.capture(result, image, source));
      } catch { this.signal?.throwIfAborted(); }
      if (!plan.cropReady && result.previewPath) {
        const meta = await sharp(result.previewPath).metadata();
        await this.capture(result, () => sharp(result.previewPath), meta);
      }
    }
    const vectors = new Map(), components = new Map(), items = [];
    for (const entry of plan.entries) {
      this.signal?.throwIfAborted();
      if (entry.items === null) {
        const face = entry.head.input.type === 'face-crop';
        const input = face ? (plan.cropReady && !faceTooSmall(entry.head, plan.faceBox) ? plan.cropFile : null)
          : result.previewPath;
        entry.items = [];
        if (input) {
          const vectorKey = digest([entry.head.encoder, entry.head.input]);
          if (!vectors.has(vectorKey)) {
            const start = performance.now();
            vectors.set(vectorKey, await this.infer(input, entry, this.signal, components));
            this.timing.inferenceMs += performance.now() - start;
          }
          this.signal?.throwIfAborted();
          entry.items = observationsFromVector(vectors.get(vectorKey), entry.head, { box: face ? plan.faceBox : undefined });
        }
        try { await publish(entry.file, JSON.stringify({ key: entry.key, items: entry.items })); }
        catch { this.signal?.throwIfAborted(); /* Inference remains usable without a writable cache. */ }
      }
      items.push(...entry.items);
    }
    this.signal?.throwIfAborted();
    result.observations = { version: this.version, items };
    this.plans.delete(result.unitId);
  }
}
