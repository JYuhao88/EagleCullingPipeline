import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const gazeEncoder = 'mediapipe-iris-pose-q2-clip-b32-q';
const dimensions = { 'clip-b32-q': 512, 'dinov2-small': 384, [gazeEncoder]: 740 };
const weights = new WeakMap();
const finiteArray = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);
const label = value => typeof value?.text === 'string' && value.text.trim().length > 0
  && [...value.text].length <= 12 && ['good', 'bad', 'neutral'].includes(value.tone);
const digest = value => createHash('sha256').update(value).digest('hex');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function decode(attribute, size, rows) {
  if (finiteArray(attribute.weights, size * rows)) return attribute.weights;
  const q = attribute.quantization;
  if (typeof attribute.weights !== 'string' || !['int8', 'int16le'].includes(q?.dtype)
    || q.layout !== 'hidden-input' || !finiteArray(q.scales, rows) || q.scales.some(scale => scale <= 0)) return null;
  const cached = weights.get(attribute);
  const signature = JSON.stringify([attribute.weights, q, size, rows]);
  if (cached?.signature === signature) return cached.decoded;
  let bytes = Buffer.from(attribute.weights, 'base64');
  if (bytes.toString('base64') !== attribute.weights) return null;
  const byteLength = size * rows * (q.dtype === 'int8' ? 1 : 2);
  if (q.encoding === 'gzip-base64') {
    try { bytes = gunzipSync(bytes, { maxOutputLength: byteLength }); } catch { return null; }
  } else if (q.encoding !== 'base64') return null;
  if (bytes.length !== byteLength) return null;
  const decoded = Array.from({ length: size * rows }, (_, i) =>
    (q.dtype === 'int8' ? bytes.readInt8(i) : bytes.readInt16LE(i * 2)) * q.scales[Math.floor(i / size)]);
  weights.set(attribute, { signature, decoded });
  return decoded;
}

export function validObservationHead(head) {
  const size = dimensions[head?.encoder?.id];
  if (!size || head.encoder.dimensions !== size || !validSha(head.encoder.modelSha256)
    || (head.encoder.id === gazeEncoder && (!validSha(head.encoder.clipModelSha256) || head.input?.type !== 'face-crop'))
    || typeof head.version !== 'string' || !head.version.trim() || head.version.length > 128
    || !['face-crop', 'full'].includes(head.input?.type)
    || (head.input.type === 'face-crop' && (head.input.size !== 384 || head.input.expansion !== 1.8))
    || (head.input.minFaceHeight !== undefined && (head.input.type !== 'face-crop'
      || !Number.isFinite(head.input.minFaceHeight) || head.input.minFaceHeight <= 0 || head.input.minFaceHeight >= 1))
    || !Array.isArray(head.attributes) || !head.attributes.length || head.attributes.length > 64) return false;
  const ids = new Set();
  return head.attributes.every(attribute => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(attribute?.id || '') || ids.has(attribute.id)) return false;
    ids.add(attribute.id);
    if (!label(attribute.positive) || (attribute.negative != null && !label(attribute.negative))
      || !finiteArray(attribute.normalization?.mean, size) || !finiteArray(attribute.normalization?.scale, size)
      || attribute.normalization.scale.some(scale => scale <= 0)
      || !Number.isFinite(attribute.temperature) || attribute.temperature <= 0
      || !Number.isFinite(attribute.showThreshold) || attribute.showThreshold <= 0.5 || attribute.showThreshold > 1) return false;
    if (attribute.type === 'logistic') return Number.isFinite(attribute.bias) && decode(attribute, size, 1) !== null;
    const hidden = attribute.bias?.length;
    return attribute.type === 'mlp' && Number.isInteger(hidden) && hidden > 0 && hidden <= 8
      && finiteArray(attribute.bias, hidden) && finiteArray(attribute.outputWeights, hidden)
      && Number.isFinite(attribute.outputBias) && decode(attribute, size, hidden) !== null;
  });
}

// Faces smaller than the training data's smallest face are out of distribution; the head stays silent.
export function faceTooSmall(head, box) {
  return head.input?.minFaceHeight !== undefined && !(box && box[3] - box[1] >= head.input.minFaceHeight);
}

export function observationsFromVector(vector, head, { box } = {}) {
  if (!validObservationHead(head) || !vector || vector.length !== head.encoder.dimensions
    || !Array.from(vector).every(Number.isFinite) || faceTooSmall(head, box)) return [];
  const size = vector.length;
  return head.attributes.flatMap(attribute => {
    const input = Array.from(vector, (value, index) =>
      (value - attribute.normalization.mean[index]) / attribute.normalization.scale[index]);
    const w = decode(attribute, size, attribute.type === 'mlp' ? attribute.bias.length : 1);
    let logit = attribute.type === 'mlp' ? attribute.outputBias : attribute.bias;
    if (attribute.type === 'mlp') {
      for (let h = 0; h < attribute.bias.length; h++) {
        let activation = attribute.bias[h];
        for (let i = 0; i < size; i++) activation += w[h * size + i] * input[i];
        logit += Math.max(0, activation) * attribute.outputWeights[h];
      }
    } else for (let i = 0; i < size; i++) logit += w[i] * input[i];
    if (!Number.isFinite(logit)) return [];
    const probability = 1 / (1 + Math.exp(-logit / attribute.temperature));
    const confidence = Math.max(probability, 1 - probability);
    const selected = probability >= 0.5 ? attribute.positive : attribute.negative;
    if (confidence < attribute.showThreshold || !selected) return [];
    return [{ id: attribute.id, text: selected.text, tone: selected.tone,
      source: 'model', confidence, ...(box ? { box } : {}) }];
  });
}

export function observationCacheKey({ fingerprint, version, encoderSha, input, headHash, faceBox, sourceIdentity }) {
  return digest(JSON.stringify(['observations-v1', fingerprint, version, encoderSha, input, headHash, faceBox, sourceIdentity]));
}

export function observationModelPath(root, encoder) {
  return encoder === gazeEncoder ? path.resolve(root, 'models', 'mediapipe', 'face_landmarker.task')
    : encoder === 'clip-b32-q' ? path.join(root, 'models', 'clip', 'vision_model_quantized.onnx')
    : path.resolve(root, process.env.EAGLE_DINO_MODEL || path.join('models', 'dinov2-small', 'model.onnx'));
}

async function modelDigest(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest('hex');
}

export async function loadObservationHeads({ root = process.cwd(),
  directory = path.join(root, 'src', 'core', 'observation-heads'), signal } = {}) {
  signal?.throwIfAborted();
  let names;
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort(); }
  catch { signal?.throwIfAborted(); return []; }
  const loaded = [], hashes = new Map();
  // Without a JSON head, there is no model stat/hash, encoder session, image I/O or per-unit work.
  for (const name of names) {
    signal?.throwIfAborted();
    try {
      const head = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (!validObservationHead(head)) continue;
      const model = observationModelPath(root, head.encoder.id);
      if (!hashes.has(model)) hashes.set(model, await modelDigest(model, signal));
      if (hashes.get(model) !== head.encoder.modelSha256) continue;
      const clipModel = head.encoder.id === gazeEncoder
        ? path.resolve(root, 'models', 'clip', 'vision_model_quantized.onnx') : null;
      if (clipModel) {
        if (!hashes.has(clipModel)) hashes.set(clipModel, await modelDigest(clipModel, signal));
        if (hashes.get(clipModel) !== head.encoder.clipModelSha256) continue;
      }
      loaded.push({ head, model, ...(clipModel ? { clipModel } : {}), hash: digest(JSON.stringify(head)) });
    } catch { signal?.throwIfAborted(); }
  }
  return loaded;
}
