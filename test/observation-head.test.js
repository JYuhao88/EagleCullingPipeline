import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadObservationHeads, observationCacheKey, observationsFromVector, validObservationHead }
  from '../src/core/observation-head.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/observation-head.json', import.meta.url), 'utf8'));
const model = () => structuredClone(fixture);
const vector = first => [first, ...Array(383).fill(0)];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const sha = value => createHash('sha256').update(value).digest('hex');
const gazeModel = () => {
  const head = model();
  head.encoder = { id: 'mediapipe-iris-pose-q2-clip-b32-q', dimensions: 740,
    modelSha256: sha('fixture-landmarker'), clipModelSha256: sha('fixture-clip') };
  head.input.minFaceHeight = .05;
  const attribute = head.attributes[0];
  attribute.weights = [1, ...Array(739).fill(0)];
  attribute.normalization = { mean: Array(740).fill(0), scale: Array(740).fill(1) };
  attribute.bias = 0; attribute.temperature = 1; attribute.showThreshold = .9;
  attribute.id = 'gaze'; attribute.positive = { text: '看镜头', tone: 'neutral' };
  delete attribute.negative;
  return head;
};

test('logistic normalization, temperature, positive/negative calibrated confidence and box are numeric', () => {
  const head = model(), box = [.2, .3, .4, .5];
  const [positive] = observationsFromVector(vector(3), head, { box });
  close(positive.confidence, .9);
  assert.deepEqual({ ...positive, confidence: .9 }, { id: 'smile', text: '在笑', tone: 'good', source: 'model',
    confidence: .9, box });
  const negative = observationsFromVector(vector(-5.788898309344878), head)[0];
  close(negative.confidence, .9);
  assert.equal(negative.text, '没有笑');
  assert.equal(negative.tone, 'neutral');
  assert.deepEqual(observationsFromVector(vector(1), head), []);
  assert.deepEqual(observationsFromVector([NaN, ...Array(383).fill(0)], head), []);
  assert.deepEqual(observationsFromVector([1], head), []);
  head.attributes[0].showThreshold = .91;
  assert.deepEqual(observationsFromVector(vector(3), head), []);
  head.attributes[0].showThreshold = positive.confidence;
  assert.equal(observationsFromVector(vector(3), head).length, 1);
});

test('a head without negative text only states the positive observation', () => {
  const head = model();
  delete head.attributes[0].negative;
  assert.equal(validObservationHead(head), true);
  assert.equal(observationsFromVector(vector(3), head)[0].text, '在笑');
  assert.deepEqual(observationsFromVector(vector(-5.788898309344878), head), []);
  head.attributes[0].negative = { text: '', tone: 'neutral' };
  assert.equal(validObservationHead(head), false);
});

test('a face-crop head with minFaceHeight stays silent on smaller or missing faces', () => {
  const head = model();
  head.input.minFaceHeight = .05;
  assert.equal(validObservationHead(head), true);
  assert.equal(observationsFromVector(vector(3), head, { box: [.2, .3, .4, .36] }).length, 1);
  assert.deepEqual(observationsFromVector(vector(3), head, { box: [.2, .3, .4, .349] }), []);
  assert.deepEqual(observationsFromVector(vector(3), head), []);
  for (const bad of [0, 1, -0.1, NaN, '0.05']) {
    head.input.minFaceHeight = bad;
    assert.equal(validObservationHead(head), false);
  }
  const full = model(); full.input = { type: 'full', minFaceHeight: .05 };
  assert.equal(validObservationHead(full), false);
});

test('small ReLU MLP matches float, signed int8 and gzip int16 little-endian weights', () => {
  const head = model(), attribute = head.attributes[0];
  Object.assign(attribute, { type: 'mlp', weights: [...vector(2), ...vector(-2)], bias: [0, 1],
    outputWeights: [3, 1], outputBias: -1 });
  const expected = 1 / (1 + Math.exp(-2.5));
  close(observationsFromVector(vector(3), head)[0].confidence, expected);
  const bytes = Buffer.alloc(768); bytes.writeInt8(2, 0); bytes.writeInt8(-2, 384);
  attribute.weights = bytes.toString('base64');
  attribute.quantization = { dtype: 'int8', encoding: 'base64', layout: 'hidden-input', scales: [1, 1] };
  close(observationsFromVector(vector(3), head)[0].confidence, expected);
  const shorts = Buffer.alloc(1536); shorts.writeInt16LE(4, 0); shorts.writeInt16LE(-4, 768);
  attribute.weights = gzipSync(shorts).toString('base64');
  attribute.quantization = { dtype: 'int16le', encoding: 'gzip-base64', layout: 'hidden-input', scales: [.5, .5] };
  close(observationsFromVector(vector(3), head)[0].confidence, expected);
  attribute.weights = gzipSync(Buffer.alloc(2)).toString('base64');
  assert.equal(validObservationHead(head), false);
});

test('strict shape, encoder, input, calibration, labels and required fields reject the entire head', () => {
  assert.equal(validObservationHead(model()), true);
  const mutations = [h => delete h.version, h => delete h.encoder, h => h.encoder.modelSha256 = 'bad',
    h => h.encoder.dimensions = 512, h => h.encoder.id = 'other', h => delete h.input,
    h => h.input.size = 224, h => h.input.expansion = 2, h => h.attributes = [],
    h => h.attributes.push(structuredClone(h.attributes[0])), h => delete h.attributes[0].positive,
    h => h.attributes[0].weights.pop(), h => delete h.attributes[0].bias,
    h => h.attributes[0].normalization.mean.pop(), h => h.attributes[0].normalization.scale[0] = 0,
    h => delete h.attributes[0].temperature, h => h.attributes[0].temperature = -1,
    h => h.attributes[0].showThreshold = .5, h => h.attributes[0].showThreshold = 1.1,
    h => h.attributes[0].positive.tone = 'better', h => h.attributes[0].positive.text = '很'.repeat(13)];
  for (const mutate of mutations) {
    const head = model(); mutate(head);
    assert.equal(validObservationHead(head), false);
    assert.deepEqual(observationsFromVector(vector(3), head), []);
  }
  const clip = model(); clip.encoder.id = 'clip-b32-q'; clip.encoder.dimensions = 512;
  clip.input = { type: 'full' };
  for (const array of [clip.attributes[0].weights, clip.attributes[0].normalization.mean,
    clip.attributes[0].normalization.scale]) array.push(...Array(128).fill(array === clip.attributes[0].normalization.scale ? 1 : 0));
  assert.equal(validObservationHead(clip), true);
});

test('loader disables missing/malformed heads, a wrong model SHA and incompatible shapes without inference', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observation-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'heads'), models = path.join(root, 'models', 'dinov2-small');
  await mkdir(directory); await mkdir(models, { recursive: true });
  await writeFile(path.join(directory, 'README.md'), 'No deployed head.');
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  await writeFile(path.join(models, 'model.onnx'), 'fixture-model');
  await writeFile(path.join(directory, 'test.json'), JSON.stringify(model()));
  assert.equal((await loadObservationHeads({ root, directory })).length, 1);
  for (const change of [h => h.encoder.modelSha256 = '0'.repeat(64),
    h => h.attributes[0].weights.pop(), h => delete h.attributes[0].positive]) {
    const head = model(); change(head);
    await writeFile(path.join(directory, 'test.json'), JSON.stringify(head));
    assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  }
  await writeFile(path.join(directory, 'test.json'), '{');
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  await writeFile(path.join(directory, 'test.json'), JSON.stringify(model()));
  await writeFile(path.join(models, 'model.onnx'), 'replaced-model');
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  const head = model(); head.encoder.modelSha256 = createHash('sha256').update('replaced-model').digest('hex');
  await writeFile(path.join(directory, 'test.json'), JSON.stringify(head));
  assert.equal((await loadObservationHeads({ root, directory })).length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadObservationHeads({ root, directory, signal: controller.signal }), { name: 'AbortError' });
});

test('cache keys bind unit fingerprint, head version/content, encoder SHA, input mode, face and source', () => {
  const base = { fingerprint: 'f', version: 'v', encoderSha: 'sha', input: { type: 'full' }, headHash: 'head',
    faceBox: [.1, .1, .2, .2], sourceIdentity: ['source'] };
  assert.equal(observationCacheKey(base), observationCacheKey(structuredClone(base)));
  for (const key of Object.keys(base)) assert.notEqual(observationCacheKey(base), observationCacheKey({ ...base, [key]: 'other' }));
});

test('iris-pose/CLIP head requires 740 features, both model digests and a face crop', () => {
  const head = gazeModel(), box = [.1, .1, .4, .4];
  assert.equal(validObservationHead(head), true);
  const [item] = observationsFromVector([Math.log(19), ...Array(739).fill(0)], head, { box });
  assert.equal(item.text, '看镜头'); close(item.confidence, .95);
  assert.deepEqual(observationsFromVector(Array(739).fill(0), head, { box }), []);
  assert.deepEqual(observationsFromVector(Array(740).fill(0), head), []);
  for (const mutate of [h => delete h.encoder.clipModelSha256,
    h => h.encoder.clipModelSha256 = 'a'.repeat(63), h => h.encoder.clipModelSha256 = 'A'.repeat(64),
    h => h.encoder.clipModelSha256 = 1, h => h.encoder.modelSha256 = 'bad',
    h => h.encoder.dimensions = 512, h => h.input = { type: 'full' },
    h => h.attributes[0].weights.pop()]) {
    const invalid = gazeModel(); mutate(invalid);
    assert.equal(validObservationHead(invalid), false);
  }
});

test('iris-pose/CLIP loader verifies both files and binds auxiliary SHA into head/cache identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observation-gaze-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'heads'), model = path.join(root, 'models', 'mediapipe', 'face_landmarker.task');
  const clipModel = path.join(root, 'models', 'clip', 'vision_model_quantized.onnx');
  await mkdir(directory); await mkdir(path.dirname(model), { recursive: true });
  await mkdir(path.dirname(clipModel), { recursive: true });
  const head = gazeModel(), file = path.join(directory, 'gaze.json');
  await writeFile(file, JSON.stringify(head));
  await writeFile(model, 'fixture-landmarker');
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  await writeFile(clipModel, 'fixture-clip');
  const [original] = await loadObservationHeads({ root, directory });
  assert.equal(original.model, model); assert.equal(original.clipModel, clipModel);
  for (const change of [h => h.encoder.modelSha256 = '0'.repeat(64),
    h => h.encoder.clipModelSha256 = '0'.repeat(64), h => delete h.encoder.clipModelSha256]) {
    const invalid = gazeModel(); change(invalid);
    await writeFile(file, JSON.stringify(invalid));
    assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  }
  await writeFile(file, JSON.stringify(head)); await writeFile(clipModel, 'replaced-clip');
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
  head.encoder.clipModelSha256 = sha('replaced-clip');
  await writeFile(file, JSON.stringify(head));
  const [replaced] = await loadObservationHeads({ root, directory });
  assert.notEqual(replaced.hash, original.hash);
  const cache = entry => observationCacheKey({ fingerprint: 'f', version: head.version,
    encoderSha: head.encoder.modelSha256, input: head.input, headHash: entry.hash });
  assert.notEqual(cache(replaced), cache(original));
  await rm(model);
  assert.deepEqual(await loadObservationHeads({ root, directory }), []);
});
