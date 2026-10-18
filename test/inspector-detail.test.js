import test from 'node:test';
import assert from 'node:assert/strict';
import { autoExposure, clampExposure, exposureLabel, exposureSlope, focusPoint, placement, readDetailState }
  from '../src/plugin/inspector/inspector-detail.js';

test('exposure is clamped to ±3 EV in tenth stops and doubles linear light per stop', () => {
  assert.equal(clampExposure(4), 3); assert.equal(clampExposure(-9), -3); assert.equal(clampExposure('x'), 0);
  assert.equal(clampExposure(0.04), 0); assert.equal(clampExposure(1.26), 1.3);
  assert.equal(exposureSlope(1), 2); assert.equal(exposureSlope(-1), 0.5); assert.equal(exposureSlope(0), 1);
  assert.equal(exposureLabel(0), '0 EV'); assert.equal(exposureLabel(0.7), '+0.7 EV'); assert.equal(exposureLabel(-1.5), '−1.5 EV');
});

test('auto exposure moves the median luminance to middle grey', () => {
  assert.equal(autoExposure([]), 0);
  const grey = 0.4614; // sRGB encoding of 18 % linear
  assert.equal(autoExposure(Array(9).fill(grey)), 0);
  assert.equal(autoExposure(Array(9).fill(0.2)), 2.4);
  assert.ok(autoExposure(Array(9).fill(0.9)) < 0);
  assert.equal(autoExposure(Array(9).fill(0)), 3);
});

test('focus prefers the main subject face, then its head keypoints, then the centre', () => {
  const main = { box: [0.4, 0.1, 0.8, 0.9], main: true, points: [[0.6, 0.2, 0.9], [0.62, 0.19, 0.9]] };
  const marks = { persons: [{ box: [0, 0, 0.2, 0.5] }, main],
    faces: [{ box: [0.05, 0.05, 0.15, 0.15] }, { box: [0.5, 0.12, 0.7, 0.3] }] };
  assert.deepEqual(focusPoint(marks).map(v => +v.toFixed(3)), [0.6, 0.21]);
  assert.deepEqual(focusPoint({ persons: [main], faces: [{ box: [0, 0, 0.1, 0.1] }] }).map(v => +v.toFixed(3)), [0.61, 0.195]);
  assert.deepEqual(focusPoint(null), [0.5, 0.5]);
});

test('placement fits at zoom 1 and centres the focus when zoomed, never showing past the image edges', () => {
  const base = { frameWidth: 300, frameHeight: 300, imageWidth: 2000, imageHeight: 3000 };
  assert.deepEqual(placement({ ...base, zoom: 1 }), { scale: 0.1, width: 200, height: 300, x: 50, y: 0 });
  const zoomed = placement({ ...base, zoom: 4, focus: [0.5, 0.5] });
  assert.equal(zoomed.width, 800); assert.equal(zoomed.x, -250); assert.equal(zoomed.y, -450);
  const corner = placement({ ...base, zoom: 4, focus: [0, 1] });
  assert.equal(corner.x, 0); assert.equal(corner.y, 300 - 1200);
});

test('stored state falls back to safe defaults', () => {
  const storage = value => ({ getItem: () => value });
  assert.deepEqual(readDetailState(storage('{"ev":9,"zoom":3,"open":true}')), { ev: 3, zoom: 2, open: true });
  assert.deepEqual(readDetailState(storage('nope')), { ev: 0, zoom: 2, open: false });
});
