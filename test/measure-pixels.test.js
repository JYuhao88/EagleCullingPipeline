import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateRules } from '../src/core/rules-engine.js';
import { syntheticPatterns, measurePattern } from '../ml/teacher/measure_calibration.mjs';

let directory;
const rows = new Map();
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'measure-pixels-'));
  // Deliberately serialize CPU work and run PNG files through the proxy decoder.
  for (const pattern of syntheticPatterns()) rows.set(pattern.name, await measurePattern(pattern, directory));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const row = (name) => rows.get(name);
const verdict = (name, id) => row(name).verdicts.find((result) => result.ruleId === id).verdict;

test('real proxy pixels measure exact histogram endpoints and genre-specific warnings', () => {
  assert.equal(row('endpoint-251').imageMeasurements.clippedHighlights, 0);
  assert.equal(row('endpoint-252').imageMeasurements.clippedHighlights, 1);
  assert.equal(row('endpoint-3').imageMeasurements.clippedShadows, 1);
  assert.equal(row('endpoint-4').imageMeasurements.clippedShadows, 0);
  assert.equal(verdict('neutral-gray', 'L-EXPOSURE-DETAIL'), 'pass');
  assert.equal(verdict('endpoint-255', 'L-EXPOSURE-DETAIL'), 'warn');
  assert.equal(verdict('endpoint-0', 'L-SHADOW-RECOVERY'), 'warn');
  assert.equal(verdict('endpoint-0', 'S-EXPOSURE-CONTENT'), 'warn');
});

test('face-region exposure is independent of clipped background and whole-image black endpoints', () => {
  const neutral = row('face-neutral-outside-white');
  assert.ok(neutral.imageMeasurements.clippedHighlights > .8);
  assert.equal(neutral.persons[0].faceClippedHighlights, 0);
  assert.equal(verdict(neutral.name, 'P-EXPOSURE-INTENT'), 'pass');
  assert.equal(verdict('face-white-outside-neutral', 'P-EXPOSURE-INTENT'), 'violate');
  const dark = row('face-dark-outside-neutral');
  assert.equal(dark.imageMeasurements.clippedShadows, 0);
  assert.equal(dark.persons[0].faceClippedShadows, 1);
  assert.equal(verdict(dark.name, 'P-EXPOSURE-INTENT'), 'warn');
  assert.equal(verdict('face-small', 'P-EXPOSURE-INTENT'), 'na');
  assert.equal(verdict('face-unknown', 'P-EXPOSURE-INTENT'), 'na');
});

test('relative color compares actual proxy pixels and abstains without group context', () => {
  const groupSignals = ['cast-128-128-128', 'cast-128-128-128', 'cast-180-128-128'].map(row);
  for (const [name, expected] of [['cast-128-128-128', 'pass'], ['cast-160-128-128', 'pass'],
    ['cast-180-128-128', 'warn']]) {
    const result = evaluateRules(row(name), { groupSignals }).find((entry) => entry.ruleId === 'P-COLOR-CAST');
    assert.equal(result.verdict, expected);
    assert.equal(verdict(name, 'P-COLOR-CAST'), 'na');
  }
  assert.equal(verdict('endpoint-255', 'P-COLOR-CAST'), 'na');
  assert.equal(verdict('endpoint-0', 'P-COLOR-CAST'), 'na');
});

test('Gaussian and motion blur reduce actual decoded proxy sharpness and trigger review', () => {
  const variance = (name) => row(name).imageMeasurements.laplacianVariance;
  assert.ok(variance('texture-clear') > variance('texture-gaussian-1'));
  assert.ok(variance('texture-gaussian-1') > variance('texture-gaussian-3'));
  assert.ok(variance('texture-gaussian-3') > variance('texture-gaussian-8'));
  assert.ok(variance('texture-clear') > variance('texture-motion-12'));
  assert.equal(verdict('texture-clear', 'G-PROXY-BLUR'), 'pass');
  assert.equal(verdict('texture-gaussian-8', 'G-PROXY-BLUR'), 'warn');
  assert.equal(verdict('texture-motion-12', 'G-PROXY-BLUR'), 'warn');
});

test('Hough consensus measures known horizontal and vertical tilted line patterns', () => {
  for (const axis of ['horizontal', 'vertical']) for (const degrees of [0, 3, 8]) {
    const measurements = row(`${axis}-${degrees}`).imageMeasurements;
    assert.ok(Math.abs(measurements[`${axis}TiltDegrees`] - degrees) < .2);
    assert.ok(measurements[`${axis}LineConfidence`] >= .65);
  }
  assert.equal(verdict('horizontal-0', 'L-HORIZON-LEVEL'), 'pass');
  assert.equal(verdict('horizontal-3', 'L-HORIZON-LEVEL'), 'warn');
  assert.equal(verdict('vertical-0', 'S-TILT-INTENT'), 'pass');
  assert.equal(verdict('vertical-8', 'S-TILT-INTENT'), 'violate');
  assert.equal(verdict('neutral-gray', 'L-HORIZON-LEVEL'), 'na');
  assert.equal(verdict('neutral-gray', 'S-TILT-INTENT'), 'na');
});

test('strong border texture raises the edge hint and small subject geometry raises a separate hint', () => {
  assert.equal(verdict('edge-control', 'G-EDGE-GRADIENT'), 'pass');
  assert.equal(verdict('edge-strong', 'G-EDGE-GRADIENT'), 'warn');
  assert.ok(row('edge-strong').imageMeasurements.edgeGradientRatio > 20);
  assert.equal(verdict('subject-center', 'P-SUBJECT-PLACEMENT'), 'pass');
  assert.equal(verdict('subject-small', 'P-SUBJECT-PLACEMENT'), 'warn');
  assert.equal(verdict('neutral-gray', 'P-SUBJECT-PLACEMENT'), 'na');
});
