import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { aestheticFromEmbedding, aestheticForResult, applyAestheticReference, clearAestheticReference,
  LEGACY_EMBEDDING_VERSION, AESTHETIC_HEAD_VERSION } from '../src/core/aesthetic-head.js';
import { groupMembersModel } from '../src/server/item-analysis.js';
import { buildCandidateSet } from '../src/core/candidates.js';
import { FeatureStore, NA } from '../src/core/feature-store.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';

const embedding = () => Array(384).fill(0);
const model = () => ({ version: 'fixture-v1', embedding: { version: LEGACY_EMBEDDING_VERSION, dimensions: 384 },
  weights: [2, ...Array(383).fill(0)], bias: 5.5,
  normalization: { mean: embedding(), scale: Array(384).fill(1) }, output: { offset: 1, scale: 9 } });

test('aesthetic head applies feature normalization, teacher scale and bounded output', () => {
  const head = model();
  const values = embedding(); values[0] = 3;
  head.normalization.mean[0] = 1; head.normalization.scale[0] = 2;
  assert.equal(aestheticFromEmbedding(values, { model: head }), 6.5 / 9);
  values[0] = 100; assert.equal(aestheticFromEmbedding(values, { model: head }), 1);
  values[0] = -100; assert.equal(aestheticFromEmbedding(values, { model: head }), 0);
});

test('aesthetic head rejects missing models, malformed embeddings and incompatible token pooling', () => {
  for (const value of [null, [], Array(383).fill(0), Array(385).fill(0), Array(384).fill(NaN), Array(384).fill(Infinity)]) {
    assert.equal(aestheticFromEmbedding(value, { model: model() }), null);
  }
  assert.equal(aestheticFromEmbedding(embedding(), { model: null }), null);
  assert.equal(aestheticFromEmbedding(embedding(), { model: model(), embeddingVersion: 'dinov2-small-cls-224-v1' }), null);
  const head = model(); head.normalization.scale[3] = 0;
  assert.equal(aestheticFromEmbedding(embedding(), { model: head }), null);
});

test('reference preserves scorer scores and refreshes its own cache by head version', () => {
  const scored = { metrics: { aesthetic: 0.8 }, embedding: embedding() };
  applyAestheticReference(scored, { model: model() });
  assert.equal(scored.metrics.aesthetic, 0.8);
  assert.equal(scored.aestheticSource, undefined);
  clearAestheticReference(scored); assert.equal(scored.metrics.aesthetic, 0.8);
  const scorerOnly = { metrics: { aesthetic: null }, scorer: { aesthetic: 0.73 }, embedding: embedding() };
  assert.equal(aestheticForResult(scorerOnly, { model: model() }), 0.73);
  applyAestheticReference(scorerOnly, { model: model() });
  assert.equal(scorerOnly.metrics.aesthetic, 0.73); assert.equal(scorerOnly.aestheticSource, undefined);
  const result = { metrics: { aesthetic: null }, embedding: embedding() };
  applyAestheticReference(result, { model: model() });
  assert.equal(result.metrics.aesthetic, 0.5);
  assert.equal(result.aestheticHeadVersion, 'fixture-v1');
  const updated = model(); updated.version = 'fixture-v2'; updated.bias = 10;
  applyAestheticReference(result, { model: updated });
  assert.equal(result.metrics.aesthetic, 1); assert.equal(result.aestheticHeadVersion, 'fixture-v2');
  clearAestheticReference(result);
  assert.equal(result.metrics.aesthetic, null); assert.equal(result.aestheticSource, undefined);
});

test('reading old embeddings computes a reference without mutating the result or inventing invalid values', () => {
  const result = { embedding: embedding(), metrics: {} };
  const original = structuredClone(result);
  assert.equal(aestheticForResult(result, { model: model() }), 0.5);
  assert.deepEqual(result, original);
  assert.equal(aestheticForResult({ ...result, embeddingVersion: 'dinov2-small-cls-224-v1' }, { model: model() }), null);
  const data = { units: [{ id: 'a' }, { id: 'b' }],
    results: [{ unitId: 'a', metrics: { aesthetic: 0.72 } }, { unitId: 'b', embedding: [1, 0] }] };
  const group = { unitIds: ['a', 'b'], ranking: [] };
  const before = structuredClone(data);
  const members = groupMembersModel(data, group);
  assert.equal(members[0].metrics.aesthetic, 0.72);
  assert.equal(members[1].metrics.aesthetic, null);
  assert.deepEqual(data, before);
});

test('pipeline strips cached head references before Pareto and preserves independent scorer aesthetics', async () => {
  const run = async reference => {
    const result = { unitId: 'a', fingerprint: 'fixture', metrics: { quality: 0.5, faces: 0,
      ...(reference ? { aesthetic: 0.9 } : {}) }, flags: [], embedding: embedding(),
    ...(reference ? { aestheticSource: 'dinov2-head', aestheticHeadVersion: 'old' } : {}) };
    const pipeline = new AnalysisPipeline({ root: '/tmp/no-aesthetic-models',
      store: { get: async () => result, put: async () => {} } });
    return pipeline.run([{ unitId: 'a' }], { nativeFocus: false });
  };
  const plain = await run(false); const cached = await run(true);
  assert.deepEqual(cached.groups, plain.groups);
  assert.equal(cached.groups[0].candidateSet.entries[0].dimensions.aesthetic, null);
  const independent = { unitId: 'a', fingerprint: 'fixture', flags: [],
    metrics: { quality: 0.5, faces: 0, aesthetic: 0.8 } };
  const pipeline = new AnalysisPipeline({ root: '/tmp/no-aesthetic-models',
    store: { get: async () => independent, put: async () => {} } });
  const scored = await pipeline.run([{ unitId: 'a' }], { nativeFocus: false });
  assert.equal(scored.results[0].metrics.aesthetic, 0.8);
  assert.equal(scored.groups[0].candidateSet.entries[0].dimensions.aesthetic, 0.8);
});

test('reference remains excluded from candidates and preference training when historical results are reused', async () => {
  const plain = [{ unitId: 'a', metrics: { quality: 0.8 } }, { unitId: 'b', metrics: { quality: 0.6 } }];
  const reference = plain.map((item, index) => ({ ...item, metrics: { ...item.metrics, aesthetic: index },
    aestheticSource: 'dinov2-head' }));
  assert.deepEqual(buildCandidateSet(reference), buildCandidateSet(plain));
  const store = new FeatureStore('/tmp/unused-aesthetic-features');
  store.put = async value => value;
  const feature = await store.fromResult({ ...reference[0], contentHash: 'a'.repeat(64) });
  assert.equal(feature.metrics.aesthetic, NA);
  const scored = await store.fromResult({ ...plain[0], metrics: { aesthetic: 0.8 }, contentHash: 'b'.repeat(64) });
  assert.equal(scored.metrics.aesthetic, 0.8);
});

test('quantized small MLP reproduces signed weights and ReLU and rejects incomplete matrices', () => {
  const head = model();
  const bytes = Buffer.alloc(384); bytes[0] = 254;
  Object.assign(head, { type: 'mlp-int8', weights: bytes.toString('base64'), bias: [1],
    outputWeights: [2], outputBias: 1, quantization: { dtype: 'int8', layout: 'hidden-input', scales: [0.5] } });
  const values = embedding();
  assert.equal(aestheticFromEmbedding(values, { model: head }), 2 / 9);
  values[0] = 2; assert.equal(aestheticFromEmbedding(values, { model: head }), 0);
  values[0] = -1; assert.equal(aestheticFromEmbedding(values, { model: head }), 4 / 9);
  assert.equal(aestheticFromEmbedding(values, { model: { ...head, weights: 'AA==' } }), null);
  assert.equal(aestheticFromEmbedding(values, { model: { ...head, weights: undefined } }), null);
});

test('compressed int16 MLP preserves signed precision and bounds decoded dimensions', () => {
  const head = model();
  const bytes = Buffer.alloc(384 * 2); bytes.writeInt16LE(-200, 0);
  Object.assign(head, { type: 'mlp-int16', weights: gzipSync(bytes).toString('base64'), bias: [1],
    outputWeights: [2], outputBias: 1,
    quantization: { dtype: 'int16le', layout: 'hidden-input', scales: [0.005], encoding: 'gzip-base64' } });
  const values = embedding(); values[0] = -1;
  assert.equal(aestheticFromEmbedding(values, { model: head }), 4 / 9);
  const oversized = { ...head, weights: gzipSync(Buffer.alloc(384 * 3)).toString('base64') };
  assert.equal(aestheticFromEmbedding(values, { model: oversized }), null);
  assert.equal(aestheticFromEmbedding(values, { model: { ...head, weights: 'AA==' } }), null);
});

test('packaged trained head backfills a legacy group member through the real JS reader', () => {
  assert.notEqual(AESTHETIC_HEAD_VERSION, 'unavailable');
  assert.match(AESTHETIC_HEAD_VERSION, /^dinov2-ava-topiq-/);
  const values = embedding(); values[0] = 1;
  const reference = aestheticFromEmbedding(values);
  assert.ok(Number.isFinite(reference) && reference >= 0 && reference <= 1);
  const data = { units: [{ id: 'legacy' }], results: [{ unitId: 'legacy', metrics: {}, embedding: values }] };
  const before = structuredClone(data);
  const members = groupMembersModel(data, { unitIds: ['legacy'], ranking: [] });
  assert.equal(members[0].metrics.aesthetic, reference);
  assert.deepEqual(data, before);
});
