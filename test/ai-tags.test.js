import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveTags, selectSceneTags, sceneCacheKey, sceneTags } from '../src/core/ai-tags.js';
import { parseCaptureMetadata } from '../src/core/capture-metadata.js';

const names = result => deriveTags(result).map(row => row.tag);
const person = indices => ({ keypoints: { points: Array.from({ length: 17 }, (_, i) =>
  [0.5, 0.1 + i * 0.04, indices.includes(i) ? 0.9 : 0]) } });

test('derived counts prefer pose persons, falling back to faces then metrics', () => {
  for (const [count, label] of [[0, '无人'], [1, '单人'], [2, '双人'], [3, '多人']]) {
    assert.ok(names({ signals: { persons: Array.from({ length: count }, () => ({})) }, faces: [{}] }).includes(`AI·${label}`));
    assert.ok(names({ faces: Array.from({ length: count }, () => ({})) }).includes(`AI·${label}`));
    assert.ok(names({ metrics: { faces: count } }).includes(`AI·${label}`));
  }
  assert.deepEqual(deriveTags(), []);
});

test('derived framing uses observable main-person joints and abstains without evidence', () => {
  for (const [indices, tag] of [[[15, 16], '全身'], [[11, 12], '半身'], [[0, 5, 6], '特写']]) {
    assert.ok(names({ signals: { persons: [person(indices)] } }).includes(`AI·${tag}`));
  }
  assert.deepEqual(names({ faces: [{}] }), ['AI·单人']);
  assert.deepEqual(names({ signals: { persons: [person([])] } }), ['AI·单人']);
  const full = person([15, 16]), close = { ...person([0, 5, 6]), isMain: true };
  assert.ok(names({ signals: { persons: [full, close] } }).includes('AI·特写'));
  assert.ok(!names({ signals: { persons: [full, close] } }).includes('AI·全身'));
});

test('derived orientation, explicit technical flags, focal ranges and source metadata', () => {
  for (const [w, h, tag] of [[2, 1, '横构图'], [1, 2, '竖构图'], [1, 1, '方构图']])
    assert.ok(names({ source: { width: w, height: h } }).includes(`AI·${tag}`));
  assert.deepEqual(names({ flags: ['blurry', 'blurry', 'overexposed', 'underexposed', 'eyes-closed', 'possibly-blurry'] }),
    ['AI·模糊', 'AI·过曝', 'AI·欠曝', 'AI·闭眼']);
  assert.deepEqual(names({ metrics: { sharpness: 0 } }), []);
  for (const [focal, tag] of [[24, '广角'], [35, '标准'], [70, '标准'], [85, '长焦']])
    assert.ok(names({ exif: { focalLength: focal } }).includes(`AI·${tag}`));
  assert.deepEqual(names({ exif: { focalLength: 0 } }), []);
  assert.deepEqual(names({ exif: { focalLength35mm: 85, focalLength: 24 } }), ['AI·长焦']);
  assert.deepEqual(deriveTags({}, { width: 2, height: 1, exif: { FocalLength: 24 } }).map(row => row.tag),
    ['AI·横构图', 'AI·广角']);
  assert.equal(parseCaptureMetadata({ FocalLength: '24', FocalLengthIn35mmFormat: 35 }).exif.focalLength35mm, 35);
});

const catalog = { version: 'test-v1', dimensions: 2, maxTags: 3, labels: [
  { tag: 'AI·海边', vector: [1, 0], threshold: 0.8 },
  { tag: 'AI·沙滩', vector: [0.9, Math.sqrt(0.19)], threshold: 0.8 },
  { tag: 'AI·天空', vector: [0.8, 0.6], threshold: 0.8 },
  { tag: 'AI·街道', vector: [0.7, Math.sqrt(0.51)], threshold: 0.6 },
  { tag: 'AI·山', vector: [0, 1], threshold: 0.8 },
] };

test('scene selection normalizes vectors, applies individual thresholds, sorts and caps top K', () => {
  assert.deepEqual(selectSceneTags([2, 0], catalog).map(row => row.tag), ['AI·海边', 'AI·沙滩', 'AI·天空']);
  assert.equal(selectSceneTags([1, 0], catalog, { maxTags: 1 }).length, 1);
  assert.equal(selectSceneTags([1, 0], catalog, { maxTags: 100 }).length, 3);
  assert.deepEqual(selectSceneTags([0, 0], catalog), []);
  assert.deepEqual(selectSceneTags([NaN, 0], catalog), []);
  assert.deepEqual(selectSceneTags([1], catalog), []);
  assert.deepEqual(selectSceneTags([-1, 0], catalog), []);
});

test('cache key includes model version, model identity, image fingerprint and vocabulary', () => {
  const base = { modelVersion: 'v1', modelIdentity: 'm1', fingerprint: 'f1', vocabularyHash: 'a' };
  assert.equal(sceneCacheKey(base), sceneCacheKey({ ...base }));
  for (const key of Object.keys(base)) assert.notEqual(sceneCacheKey(base), sceneCacheKey({ ...base, [key]: 'new' }));
});

test('scene cache avoids inference; fingerprint, vocabulary and model changes invalidate it; failures degrade', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-tags-'));
  try {
    const model = path.join(dir, 'model'), file = path.join(dir, 'image');
    await writeFile(model, 'model');
    await writeFile(file, 'image');
    let calls = 0;
    const opts = { model, cacheDir: path.join(dir, 'cache'), catalog, fingerprint: 'f1',
      infer: async () => { calls++; return [1, 0]; } };
    assert.equal((await sceneTags(file, opts)).length, 3);
    assert.equal((await sceneTags(file, opts)).length, 3);
    assert.equal(calls, 1);
    await sceneTags(file, { ...opts, fingerprint: 'f2' });
    await sceneTags(file, { ...opts, catalog: { ...catalog, version: 'v2' } });
    await writeFile(model, 'different-model');
    await sceneTags(file, opts);
    assert.equal(calls, 4);
    assert.deepEqual(await sceneTags(file, { ...opts, model: path.join(dir, 'missing') }), []);
    assert.deepEqual(await sceneTags(file, { ...opts, fingerprint: 'error', infer: async () => { throw Error('failed'); } }), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sceneTags(file, { ...opts, signal: controller.signal }), { name: 'AbortError' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
