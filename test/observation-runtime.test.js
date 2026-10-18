import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { ObservationRuntime, observationFace, observationFaceCrop, observationCropRect, observationFeatureVector }
  from '../src/core/observation-runtime.js';
import { loadObservationHeads } from '../src/core/observation-head.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { observationsFor } from '../src/core/observations.js';
import { groupMembersModel, itemAnalysisModel } from '../src/server/item-analysis.js';
import { analyzeFocusFromNativeImage } from '../src/core/focus.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/observation-head.json', import.meta.url), 'utf8'));
const vector = [3, ...Array(383).fill(0)];
const box = [.25, .25, .5, .75];
const observation = (id, source = 'model') => ({ id, text: '在笑', tone: 'good', source,
  ...(source === 'model' ? { confidence: .9 } : {}) });
const gazeEntry = { model: 'face_landmarker.task', clipModel: 'vision_model_quantized.onnx',
  head: { encoder: { id: 'mediapipe-iris-pose-q2-clip-b32-q', dimensions: 740,
    modelSha256: 'a'.repeat(64), clipModelSha256: 'b'.repeat(64) } } };

async function setup(t, input = fixture.input) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observation-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'heads'), models = path.join(root, 'models', 'dinov2-small');
  await mkdir(directory); await mkdir(models, { recursive: true });
  const head = { ...structuredClone(fixture), input };
  await writeFile(path.join(directory, 'fake.json'), JSON.stringify(head));
  await writeFile(path.join(models, 'model.onnx'), 'fixture-model');
  const preview = path.join(root, 'preview.jpg');
  const pixels = Buffer.from(Array.from({ length: 120 * 80 * 3 }, (_, i) => i % 251));
  await sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } }).jpeg().toFile(preview);
  const result = { unitId: 'u', fingerprint: 'unit-fingerprint', previewPath: preview, sourcePath: path.join(root, 'missing'),
    faces: [{ box }], metrics: { faces: 1, sharpness: .5 }, flags: [], embedding: vector };
  return { root, directory, preview, result, heads: await loadObservationHeads({ root, directory }),
    record: { unitId: 'u', exif: {}, filePath: result.sourcePath }, cacheDir: path.join(root, 'observations') };
}

test('subject face follows the main person, ambiguous matches abstain, otherwise largest face wins', () => {
  const small = { box: [.1, .1, .2, .2] }, large = { box: [.5, .1, .9, .7] };
  assert.equal(observationFace({ faces: [small, large] }), large);
  const signals = { persons: [{ isMain: true, box: [0, 0, .4, 1] }] };
  assert.equal(observationFace({ faces: [small, large], signals }), small);
  assert.equal(observationFace({ faces: [small, { box: [.2, .2, .3, .3] }, large], signals }), null);
  assert.equal(observationFace({ faces: [large], signals }), null);
  assert.equal(observationFace({ faces: [{ box: [0, 0, 0, 0] }] }), null);
});

test('face square matches the teacher crops: expansion 1.8, shifted inside the frame, 384 pixels', async () => {
  const source = { width: 200, height: 100 };
  assert.deepEqual(observationCropRect([.4, .3, .6, .7], source), { rect: { left: 64, top: 14, width: 72, height: 72 }, side: 72 });
  assert.deepEqual(observationCropRect([0, 0, .2, .4], source).rect, { left: 0, top: 0, width: 72, height: 72 });
  assert.deepEqual(observationCropRect([.1, .1, .9, .9], source).rect, { left: 50, top: 0, width: 100, height: 100 });
  const image = () => sharp({ create: { ...source, channels: 3, background: '#ffffff' } });
  const buffer = await observationFaceCrop(image, source, [0, 0, .2, .4]);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 384); assert.equal(meta.height, 384);
  const pixel = await sharp(buffer).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...pixel], [255, 255, 255]);
});

test('gaze features concatenate geometry and normalized CLIP from the same face view, sharing CLIP with face heads', async () => {
  const geometry = Float64Array.from({ length: 228 }, (_, i) => i / 100);
  const clip = [3, 4, ...Array(510).fill(0)], components = new Map(), controller = new AbortController();
  let clipCalls = 0, geometryCalls = 0;
  const dependencies = {
    async gazeGeometryVector(file, model, options, signal) {
      geometryCalls++;
      assert.equal(file, 'face.png'); assert.equal(model, gazeEntry.model);
      assert.deepEqual(options, { modelSha256: gazeEntry.head.encoder.modelSha256 });
      assert.equal(signal, controller.signal);
      return geometry;
    },
    async clipImageVector(file, model, options, signal) {
      clipCalls++;
      assert.equal(file, 'face.png'); assert.equal(model, gazeEntry.clipModel);
      assert.deepEqual(options, {}); assert.equal(signal, controller.signal);
      return clip;
    }
  };
  const faceEntry = { model: gazeEntry.clipModel, head: { encoder: { id: 'clip-b32-q', dimensions: 512,
    modelSha256: gazeEntry.head.encoder.clipModelSha256 } } };
  const face = await observationFeatureVector('face.png', faceEntry, controller.signal, components, dependencies);
  const gaze = await observationFeatureVector('face.png', gazeEntry, controller.signal, components, dependencies);
  assert.deepEqual(face, [.6, .8, ...Array(510).fill(0)]);
  assert.equal(gaze.length, 740);
  assert.deepEqual(gaze.slice(0, 228), Array.from(geometry));
  assert.deepEqual(gaze.slice(228), face);
  assert.equal(clipCalls, 1); assert.equal(geometryCalls, 1);
  await observationFeatureVector('another-face.png', faceEntry, undefined, components, {
    clipImageVector: async () => { clipCalls++; return clip; } });
  assert.equal(clipCalls, 2);
});

test('gaze abstains on missing or malformed geometry and unusable CLIP, without substituting face-only features', async () => {
  for (const geometry of [null, Array(227).fill(0), [...Array(227).fill(0), NaN], [...Array(227).fill(0), Infinity]]) {
    const feature = await observationFeatureVector('face.png', gazeEntry, undefined, new Map(), {
      gazeGeometryVector: async () => geometry,
      clipImageVector: () => assert.fail('missing geometry must not run CLIP') });
    assert.equal(feature, null);
  }
  for (const clip of [null, Array(511).fill(1), Array(512).fill(0), Array(512).fill(1e308), [...Array(511).fill(1), NaN]]) {
    const feature = await observationFeatureVector('face.png', gazeEntry, undefined, new Map(), {
      gazeGeometryVector: async () => Array(228).fill(0), clipImageVector: async () => clip });
    assert.equal(feature, null);
  }
});

test('DINO features keep their existing path; feature cancellation propagates before the next component', async () => {
  const dinoEntry = { model: 'model.onnx', head: { encoder: { id: 'dinov2-small' } } };
  assert.equal(await observationFeatureVector('face.png', dinoEntry, undefined, new Map(), {
    dinoImageVector: async (file, model) => {
      assert.equal(file, 'face.png'); assert.equal(model, dinoEntry.model); return vector;
    } }), vector);
  const controller = new AbortController();
  await assert.rejects(observationFeatureVector('face.png', gazeEntry, controller.signal, new Map(), {
    gazeGeometryVector: async () => { controller.abort(Error('cancel geometry')); return Array(228).fill(0); },
    clipImageVector: () => assert.fail('cancelled geometry must not run CLIP') }), /cancel geometry/);
  const clipController = new AbortController();
  await assert.rejects(observationFeatureVector('face.png', gazeEntry, clipController.signal, new Map(), {
    gazeGeometryVector: async () => Array(228).fill(0),
    clipImageVector: async () => { clipController.abort(Error('cancel clip')); return Array(512).fill(1); }
  }), /cancel clip/);
  await assert.rejects(observationFeatureVector('face.png', gazeEntry, controller.signal, new Map(), {
    gazeGeometryVector: () => assert.fail('already cancelled') }), /cancel geometry/);
});

test('focus hands its already decoded pixels to observations without reopening the native image', async t => {
  const f = await setup(t), bytes = await readFile(f.preview);
  const runtime = new ObservationRuntime(f.heads, { cacheDir: f.cacheDir, infer: async () => vector });
  await runtime.prepare(f.result, f.record);
  let opens = 0;
  const source = { width: 120, height: 80, rawWidth: 120, rawHeight: 80, orientation: 1 };
  const focus = await analyzeFocusFromNativeImage({ image: () => { opens++; return sharp(bytes); }, source,
    faces: f.result.faces, onNativePixels: (image, nativeSource) => runtime.capture(f.result, image, nativeSource) });
  assert.equal(opens, 2);
  assert.equal(focus.status, 'ok');
  assert.equal(runtime.plans.get('u').cropReady, true);
  await runtime.analyze(f.result, f.record);
  assert.equal(f.result.observations.items.length, 1);
});

test('runtime uses preview fallback, inference/cache reuse and rejects cached confidence below threshold', async t => {
  const f = await setup(t);
  let calls = 0;
  const options = { cacheDir: f.cacheDir, infer: async (input, entry, signal) => {
    signal?.throwIfAborted(); calls++;
    assert.equal((await sharp(input).metadata()).width, 384);
    assert.equal(entry.head.encoder.id, 'dinov2-small'); return vector;
  } };
  const first = new ObservationRuntime(f.heads, options);
  await first.prepare(f.result, f.record); await first.analyze(f.result, f.record);
  assert.equal(f.result.observations.items.length, 1);
  assert.deepEqual(f.result.observations.items[0].box, box);
  assert.equal(calls, 1);
  const second = new ObservationRuntime(f.heads, { ...options, infer: () => assert.fail('cached inference') });
  await second.prepare(f.result, f.record);
  const entry = second.plans.get('u').entries[0];
  await second.analyze(f.result, f.record);
  assert.equal(second.timing.cacheHits, 1);
  await writeFile(entry.file, JSON.stringify({ key: entry.key, items: [{ ...observation('smile'), confidence: .1 }] }));
  const third = new ObservationRuntime(f.heads, options);
  await third.prepare(f.result, f.record); await third.analyze(f.result, f.record);
  assert.equal(calls, 2);
  const changed = new ObservationRuntime([{ ...f.heads[0], hash: 'changed-content' }], options);
  await changed.prepare(f.result, f.record); await changed.analyze(f.result, f.record);
  assert.equal(calls, 3);
});

test('full heads share one encoder vector per unit; no-face crops abstain without inference', async t => {
  const f = await setup(t, { type: 'full' });
  let calls = 0;
  const runtime = new ObservationRuntime([f.heads[0], { ...f.heads[0], hash: 'second' }], {
    cacheDir: f.cacheDir, infer: async input => { calls++; assert.equal(input, f.preview); return vector; } });
  await runtime.prepare(f.result, f.record); await runtime.analyze(f.result, f.record);
  assert.equal(calls, 1);
  const crop = new ObservationRuntime([{ ...f.heads[0], hash: 'crop', head: fixture }], {
    cacheDir: f.cacheDir, infer: () => assert.fail('no subject face') });
  f.result.faces = [];
  await crop.prepare(f.result, f.record); await crop.analyze(f.result, f.record);
  assert.deepEqual(f.result.observations.items, []);
});

test('runtime shares component features across heads and abstains on unavailable gaze geometry', async t => {
  const f = await setup(t), size = 740;
  const head = { ...structuredClone(f.heads[0].head), version: 'fixture-gaze-v1',
    encoder: gazeEntry.head.encoder, input: { ...fixture.input, minFaceHeight: .05 } };
  head.attributes = head.attributes.map(attribute => ({ ...attribute, id: 'looking-camera',
    positive: { text: '看镜头', tone: 'neutral' }, weights: Array(size).fill(0), bias: 10,
    normalization: { mean: Array(size).fill(0), scale: Array(size).fill(1) } }));
  const gaze = { ...gazeEntry, head, hash: 'gaze' }, maps = [];
  const runtime = new ObservationRuntime([f.heads[0], gaze], { cacheDir: f.cacheDir,
    infer: async (file, entry, signal, components) => {
      maps.push(components);
      assert.ok(components instanceof Map);
      if (entry.head.encoder.id === 'dinov2-small') { components.set('face', true); return vector; }
      assert.equal(components.get('face'), true);
      return observationFeatureVector(file, entry, signal, components, {
        gazeGeometryVector: async () => null, clipImageVector: () => assert.fail('missing geometry') });
    } });
  await runtime.prepare(f.result, f.record); await runtime.analyze(f.result, f.record);
  assert.equal(maps.length, 2); assert.equal(maps[0], maps[1]);
  assert.deepEqual(f.result.observations.items.map(item => item.id), ['smile']);
  const complete = new ObservationRuntime([{ ...gaze, hash: 'gaze-complete' }], { cacheDir: f.cacheDir,
    infer: (file, entry, signal, components) => observationFeatureVector(file, entry, signal, components, {
      gazeGeometryVector: async () => Array(228).fill(.1), clipImageVector: async () => Array(512).fill(1) }) });
  await complete.prepare(f.result, f.record); await complete.analyze(f.result, f.record);
  assert.equal(f.result.observations.items[0].text, '看镜头');
  assert.deepEqual(f.result.observations.items[0].box, box);
  const small = { ...f.result, unitId: 'small', faces: [{ box: [.25, .25, .5, .299] }] };
  const smallRuntime = new ObservationRuntime([gaze], { cacheDir: f.cacheDir,
    infer: () => assert.fail('small gaze face') });
  await smallRuntime.prepare(small, f.record); await smallRuntime.analyze(small, f.record);
  assert.deepEqual(small.observations.items, []);
});

test('faces below minFaceHeight abstain without cropping or inference', async t => {
  const f = await setup(t, { ...fixture.input, minFaceHeight: .6 });
  const runtime = new ObservationRuntime(f.heads, { cacheDir: f.cacheDir, infer: () => assert.fail('small face') });
  await runtime.prepare(f.result, f.record);
  assert.equal(runtime.plans.get('u').needsCrop, false);
  await runtime.analyze(f.result, f.record);
  assert.deepEqual(f.result.observations.items, []);
});

test('abort after a native inference returns propagates and does not publish observations', async t => {
  const f = await setup(t, { type: 'full' });
  const controller = new AbortController();
  const runtime = new ObservationRuntime(f.heads, { cacheDir: f.cacheDir, signal: controller.signal,
    infer: async () => { controller.abort(new Error('cancel observation')); return vector; } });
  await runtime.prepare(f.result, f.record);
  await assert.rejects(runtime.analyze(f.result, f.record), /cancel observation/);
  assert.equal(f.result.observations, undefined);
});

test('pipeline has no observation phase/timing/inference without a deployed valid head, strips stale results', async t => {
  const f = await setup(t);
  await rm(path.join(f.directory, 'fake.json'));
  f.result.observations = { version: 'old', items: [observation('smile')] };
  const stages = [];
  const pipeline = new AnalysisPipeline({ root: f.root, cacheRoot: f.root, observationHeadDir: f.directory,
    poseDetector: async () => [], faceDetector: async () => [],
    observationInfer: () => assert.fail('disabled'),
    store: { get: async () => structuredClone(f.result), put: async () => {} } });
  const run = await pipeline.run([{ unitId: 'u', exif: {} }], { nativeFocus: false,
    onProgress: row => stages.push(row.stage) });
  assert.equal(stages.includes('observations'), false);
  assert.equal(run.observationTimingMs, undefined);
  assert.equal(run.results[0].observations, undefined);
  assert.equal(run.status, 'completed');
});

test('observation checkpoint resumes after focus, uses cached heads and keeps grouping/ranking unchanged', async t => {
  const f = await setup(t, { type: 'full' });
  let calls = 0;
  const saved = new Map();
  const checkpoint = { get: async key => saved.get(key), put: async (key, row) => saved.set(key, structuredClone(row)) };
  const pipeline = new AnalysisPipeline({ root: f.root, cacheRoot: f.root, observationHeadDir: f.directory,
    poseDetector: async () => [], faceDetector: async () => [],
    observationInfer: async () => { calls++; return vector; }, analyzer: async () => ({ metrics: {}, embedding: vector }),
    store: { get: async key => ({ ...structuredClone(f.result), fingerprint: key }), put: async () => {} } });
  const records = [{ unitId: 'u', exif: {}, analysisPath: f.preview }];
  const controller = new AbortController(), phases = [];
  await assert.rejects(pipeline.run(records, { nativeFocus: false, checkpoint, signal: controller.signal,
    onProgress(row) { phases.push(row.stage); if (row.stage === 'observations' && row.completed) controller.abort(Error('stop')); }
  }), /stop/);
  assert.ok(phases.indexOf('observations') > phases.indexOf('focus'));
  assert.equal(saved.get('unit:u').stage, 'observations');
  assert.equal(calls, 1);
  const resumed = await pipeline.run(records, { nativeFocus: false, checkpoint });
  assert.equal(calls, 1);
  assert.equal(resumed.observationTimingMs.cacheHits, 1);
  assert.equal(resumed.results[0].observations.items.length, 1);
  await rm(path.join(f.directory, 'fake.json'));
  const disabled = await pipeline.run(records, { nativeFocus: false });
  assert.deepEqual(resumed.groups, disabled.groups);
});

test('merge puts closed eyes, then model items, then rules; rule wins a duplicate id; four items maximum', () => {
  const result = { unitId: 'u', observations: { version: 'v', items: [observation('smile'), observation('mouth'),
    observation('extra'), { id: 'bad', confidence: NaN }] } };
  const before = structuredClone(result);
  const rule = { ...observation('smile', 'rule'), text: '笑了', tone: 'good' };
  const eyes = { ...observation('eyes-closed', 'rule'), text: '主体闭眼', tone: 'bad' };
  const merged = observationsFor(result, { rules: () => [observation('pose', 'rule'), rule, eyes] });
  assert.deepEqual(merged.map(item => item.id), ['eyes-closed', 'mouth', 'extra', 'pose']);
  assert.equal(merged[0], eyes);
  assert.deepEqual(observationsFor(result, { rules: () => [rule] }).map(item => item.id), ['mouth', 'extra', 'smile']);
  assert.deepEqual(result, before);
  assert.deepEqual(observationsFor({ observations: { items: 'bad' } }), []);
  const data = { run: { id: 'run' }, units: [{ id: 'u', primaryItemId: 'i' }], results: [result],
    groups: [{ id: 'g', unitIds: ['u'], ranking: [{ unitId: 'u', rank: 1 }] }] };
  assert.deepEqual(groupMembersModel(data, data.groups[0])[0].observations, observationsFor(result));
  assert.deepEqual(itemAnalysisModel(data, 'u').observations, observationsFor(result));
});
