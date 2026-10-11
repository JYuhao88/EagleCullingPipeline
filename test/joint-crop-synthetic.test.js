import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryRect, transformPoints, truthMatch } from '../ml/teacher/joint_crop_synthetic.mjs';

test('synthetic crop maps source landmarks to actual integer pixel boundaries', () => {
  const size = { width: 100, height: 200 };
  const rect = boundaryRect(size, 'bottom', .502);
  assert.deepEqual(rect, { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(transformPoints([[.3, .5, .9], [.4, .75, .8]], rect, size),
    [[.3, 1, .9], [.4, 1.5, .8]]);
  const top = boundaryRect(size, 'top', .25);
  assert.deepEqual(transformPoints([[.2, .25, 1], [.3, 1, .8]], top, size),
    [[.2, 0, 1], [.3, 1, .8]]);
});
test('synthetic truth never turns unknown or missing pose into a pass', () => {
  assert.equal(truthMatch('crop', 'crop'), true);
  assert.equal(truthMatch('safe', 'crop'), false);
  for (const value of ['uncertain', 'na', undefined, null]) {
    assert.equal(truthMatch('safe', value), null);
    assert.equal(truthMatch(value, 'safe'), null);
  }
});

test('synthetic pixel crop removes pixels beyond known joint boundary', async () => {
  const { default: sharp } = await import('sharp');
  const pixels = Buffer.alloc(10 * 20 * 3);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) {
    pixels[(y * 10 + x) * 3] = y * 10;
  }
  const crop = boundaryRect({ width: 10, height: 20 }, 'bottom', .5);
  const result = await sharp(pixels, { raw: { width: 10, height: 20, channels: 3 } })
    .extract(crop).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.height, 10);
  assert.equal(result.data.at(-3), 90);
  assert.deepEqual(transformPoints([[.5, .5, 1]], crop, { width: 10, height: 20 }), [[.5, 1, 1]]);
});
