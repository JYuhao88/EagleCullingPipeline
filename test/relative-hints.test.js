import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/core/rules-engine.js';

function image(headroom = .4, tier = 'full', channels = [128, 128, 128]) {
  return {
    persons: [{ isMain: true, headroomHeads: headroom, framingTier: tier }],
    imageMeasurements: { version: 'measure-v3', grayWorldPixels: 200, channelMeans: channels,
      grayWorldDeviation: (Math.max(...channels) - Math.min(...channels)) / Math.max(...channels) },
  };
}
const result = (id, current, groupSignals) => evaluateRules(current, { groupSignals })
  .find((entry) => entry.ruleId === id);

test('headroom hints compare a robust median within the same framing tier', () => {
  const group = [image(.3), image(.4), image(.5), image(2), image(20, 'chest')];
  assert.equal(result('P-CROP-HEADROOM', group[3], group).verdict, 'warn');
  assert.match(result('P-CROP-HEADROOM', group[3], group).evidence, /中位数 0.45/);
  assert.equal(result('P-CROP-HEADROOM', group[0], group).verdict, 'pass');
  assert.equal(result('P-CROP-HEADROOM', image(-.1), group).verdict, 'pass');
  assert.equal(result('P-CROP-HEADROOM', group[4], group).verdict, 'na');
  assert.equal(result('P-CROP-HEADROOM', image(2), [image(.4), image(2)]).verdict, 'na');
  assert.equal(result('P-CROP-HEADROOM', image(10), [image(10), image(10), image(10)]).verdict, 'pass');
  assert.equal(result('P-CROP-HEADROOM', image(1.2), group).verdict, 'pass');
});

test('a crowd contributes one image sample rather than multiplying the headroom baseline', () => {
  const crowd = image(10);
  crowd.persons = Array.from({ length: 20 }, () => ({ ...crowd.persons[0] }));
  const current = image(2);
  const group = [image(.4), image(.4), current, crowd];
  assert.equal(result('P-CROP-HEADROOM', current, group).verdict, 'warn');
});

test('color hints require a deviation from group color, not absolute channel dominance', () => {
  const cast = image(.4, 'full', [180, 128, 128]);
  const group = [image(), image(), cast];
  assert.equal(result('P-COLOR-CAST', cast, group).verdict, 'warn');
  assert.equal(result('P-COLOR-CAST', group[0], group).verdict, 'pass');
  assert.equal(result('P-COLOR-CAST', cast, [cast, cast, cast]).verdict, 'pass');
  assert.equal(result('P-COLOR-CAST', cast, [image(), cast]).verdict, 'na');
  const scaled = image(.4, 'full', [90, 64, 64]);
  assert.equal(result('P-COLOR-CAST', cast, [scaled, scaled, cast]).verdict, 'pass');
});

test('warm light, dark scenes, invalid values and outdated color samples abstain', () => {
  const group = [image(), image(), image()];
  for (const channels of [[180, 128, 80], [35, 50, 35], [NaN, 128, 128], [-1, 128, 128], [256, 128, 128]])
    assert.equal(result('P-COLOR-CAST', image(.4, 'full', channels), group).verdict, 'na');
  const invalid = image();
  invalid.imageMeasurements.version = 'measure-v2';
  assert.equal(result('P-COLOR-CAST', invalid, group).verdict, 'na');
  assert.equal(result('P-COLOR-CAST', image(), [image(), image(), invalid]).verdict, 'na');
  invalid.imageMeasurements.version = 'measure-v3';
  invalid.imageMeasurements.grayWorldPixels = 63;
  assert.equal(result('P-COLOR-CAST', invalid, group).verdict, 'na');
});
