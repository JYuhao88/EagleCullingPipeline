import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const LEGACY_EMBEDDING_VERSION = 'dinov2-small-mean-patch-224-v1';
const dimensions = 384;
const vector = value => Array.isArray(value) && value.length === dimensions && value.every(Number.isFinite);

const mlpWeights = new WeakMap();
const finiteArray = (values, length) => Array.isArray(values) && values.length === length && values.every(Number.isFinite);

function decodeMlp(head) {
  if (typeof head.weights !== 'string') return null;
  const cached = mlpWeights.get(head);
  if (cached && cached.encoded === head.weights && cached.hidden === head.bias.length && cached.type === head.type) {
    return cached.weights;
  }
  const encoded = Buffer.from(head.weights, 'base64');
  if (encoded.toString('base64') !== head.weights) return null;
  let weights;
  if (head.type === 'mlp-int16') {
    let bytes;
    try { bytes = gunzipSync(encoded, { maxOutputLength: dimensions * head.bias.length * 2 }); }
    catch { return null; }
    if (bytes.length !== dimensions * head.bias.length * 2) return null;
    weights = new Int16Array(dimensions * head.bias.length);
    for (let index = 0; index < weights.length; index++) weights[index] = bytes.readInt16LE(index * 2);
  } else {
    if (encoded.length !== dimensions * head.bias.length) return null;
    weights = new Int8Array(encoded.buffer, encoded.byteOffset, encoded.length);
  }
  mlpWeights.set(head, { weights, encoded: head.weights, hidden: head.bias.length, type: head.type });
  return weights;
}

function validHead(head) {
  const common = typeof head?.version === 'string' && head.version.length > 0
    && head.embedding?.dimensions === dimensions && typeof head.embedding.version === 'string'
    && vector(head.normalization?.mean) && vector(head.normalization?.scale)
    && head.normalization.scale.every(value => value > 0)
    && Number.isFinite(head.output?.offset) && Number.isFinite(head.output?.scale) && head.output.scale > 0;
  if (!common) return false;
  if (['mlp-int8', 'mlp-int16'].includes(head.type)) {
    const hidden = head.bias?.length;
    return Number.isInteger(hidden) && hidden > 0 && hidden <= 8 && finiteArray(head.bias, hidden)
      && finiteArray(head.outputWeights, hidden) && Number.isFinite(head.outputBias)
      && head.quantization?.dtype === (head.type === 'mlp-int16' ? 'int16le' : 'int8')
      && (head.type !== 'mlp-int16' || head.quantization.encoding === 'gzip-base64') && head.quantization.layout === 'hidden-input'
      && finiteArray(head.quantization.scales, hidden) && head.quantization.scales.every(value => value > 0)
      && decodeMlp(head) !== null;
  }
  return (head.type == null || head.type === 'ridge') && vector(head.weights) && Number.isFinite(head.bias);
}

let head = null;
try {
  const loaded = JSON.parse(readFileSync(new URL('./aesthetic-head.json', import.meta.url), 'utf8'));
  if (validHead(loaded)) head = loaded;
} catch { /* An unavailable model must remain unknown rather than invent a reference score. */ }

export const AESTHETIC_HEAD_VERSION = head?.version || 'unavailable';

export function aestheticFromEmbedding(embedding, {
  embeddingVersion = LEGACY_EMBEDDING_VERSION, model = head,
} = {}) {
  if (!validHead(model) || !vector(embedding) || embeddingVersion !== model.embedding.version) return null;
  let prediction;
  if (['mlp-int8', 'mlp-int16'].includes(model.type)) {
    const weights = decodeMlp(model);
    prediction = model.outputBias;
    for (let hidden = 0; hidden < model.bias.length; hidden++) {
      let activation = model.bias[hidden];
      for (let index = 0; index < dimensions; index++) {
        activation += weights[hidden * dimensions + index] * model.quantization.scales[hidden]
          * (embedding[index] - model.normalization.mean[index]) / model.normalization.scale[index];
      }
      prediction += Math.max(0, activation) * model.outputWeights[hidden];
    }
  } else {
    prediction = model.bias;
    for (let index = 0; index < dimensions; index++) {
      prediction += model.weights[index]
        * (embedding[index] - model.normalization.mean[index]) / model.normalization.scale[index];
    }
  }
  const value = (prediction - model.output.offset) / model.output.scale;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

export function aestheticForResult(result = {}, options) {
  if (result.metrics?.aesthetic != null && result.aestheticSource !== 'dinov2-head') return result.metrics.aesthetic;
  if (Number.isFinite(result.scorer?.aesthetic)) return result.scorer.aesthetic;
  return aestheticFromEmbedding(result.embedding, { embeddingVersion: result.embeddingVersion || LEGACY_EMBEDDING_VERSION,
    ...options });
}

export function clearAestheticReference(result) {
  if (result.aestheticSource !== 'dinov2-head') return;
  if (result.metrics) result.metrics.aesthetic = Number.isFinite(result.scorer?.aesthetic) ? result.scorer.aesthetic : null;
  delete result.aestheticSource;
  delete result.aestheticHeadVersion;
}

export function applyAestheticReference(result, options) {
  if (result.metrics?.aesthetic != null && result.aestheticSource !== 'dinov2-head') return;
  if (Number.isFinite(result.scorer?.aesthetic)) {
    clearAestheticReference(result);
    result.metrics ??= {};
    result.metrics.aesthetic = result.scorer.aesthetic;
    return;
  }
  const value = aestheticForResult(result, options);
  result.metrics ??= {};
  result.metrics.aesthetic = value;
  if (value === null) {
    delete result.aestheticSource;
    delete result.aestheticHeadVersion;
  } else {
    result.aestheticSource = 'dinov2-head';
    result.aestheticHeadVersion = options?.model?.version || AESTHETIC_HEAD_VERSION;
  }
}

export function metricsWithoutAestheticReference(result = {}) {
  const metrics = result.metrics || {};
  return result.aestheticSource === 'dinov2-head'
    ? { ...metrics, aesthetic: Number.isFinite(result.scorer?.aesthetic) ? result.scorer.aesthetic : null } : metrics;
}
