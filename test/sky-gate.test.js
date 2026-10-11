import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skyExposure, analyzeImage, normalizeMetrics } from '../src/core/metrics.js';
import { gateFlags, rankGroup } from '../src/core/ranking.js';

test('top-connected smooth white sky does not gate a normally exposed subject', async () => {
  const width = 96, height = 64;
  const luma = Array.from({ length: width * height }, (_, i) => Math.floor(i / width) < 24 ? 255 : 100 + i % 60);
  const sky = skyExposure(luma, width, height);
  assert.ok(sky.skyClippedFraction > .3);
  assert.ok(sky.subject.clippedHigh < .03);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sky-test-'));
  let a;
  try {
    const file = path.join(dir, 'sky.png');
    await sharp(Buffer.from(luma), { raw: { width, height, channels: 1 } }).png().toFile(file);
    a = await analyzeImage({ filePath: file });
  } finally { await rm(dir, { recursive: true, force: true }); }
  const item = { unitId: 'sky', metrics: normalizeMetrics(a.metrics), flags: [] };
  assert.ok(!gateFlags(item).includes('overexposed'));
  assert.ok(rankGroup([item])[0].reasons.includes('提示：天空过曝无细节'));
});

test('whole-frame overexposure and disconnected subject clipping remain gates', () => {
  const w = 96, h = 64;
  for (const luma of [Array(w*h).fill(255), Array.from({length:w*h}, (_,i) => Math.floor(i/w)>30 ? 255 : 120)]) {
    const sky = skyExposure(luma,w,h);
    assert.equal(sky.skyFraction,0);
    assert.ok(gateFlags({ metrics: { clippedHighlights:.5, raw:{skyExposure:sky} } }).includes('overexposed'));
  }
});

test('sky exclusion cannot hide blown subject pixels or a reliable blown face', () => {
  const w=96,h=64;
  const luma=Array.from({length:w*h},(_,i)=>Math.floor(i/w)<16 || Math.floor(i/w)>40 ? 255 : 130);
  const sky=skyExposure(luma,w,h);
  assert.ok(sky.skyFraction>.2);
  assert.ok(gateFlags({metrics:{clippedHighlights:.5,raw:{skyExposure:sky}}}).includes('overexposed'));
  const normal=skyExposure(Array.from({length:w*h},(_,i)=>Math.floor(i/w)<20 ? 255 : 130),w,h);
  assert.ok(gateFlags({metrics:{clippedHighlights:.3,raw:{skyExposure:normal,faceExposure:{clippedHigh:.2}}}}).includes('overexposed'));
});

test('bright textured upper region is not excluded as sky', () => {
  const w=96,h=64;
  const luma=Array.from({length:w*h},(_,i)=>Math.floor(i/w)<24 ? (i%2 ? 235 : 255) : 120);
  assert.equal(skyExposure(luma,w,h).skyFraction,0);
});
