import test from 'node:test';
import assert from 'node:assert/strict';
import { gateFlags, rankGroup, suggestDecision, rulePenalty } from '../src/core/ranking.js';
import { evaluateRules } from '../src/core/rules-engine.js';

const detail = (laplacianVariance, noiseSigma, quality = .1) => ({ metrics: { quality,
  raw: { technicalDetail: { version: 'detail-512-v1', laplacianVariance, noiseSigma } } } });
test('technical gates require calibrated detail plus available model quality', () => {
  assert.ok(gateFlags(detail(399, 0)).includes('blurry'));
  assert.ok(!gateFlags(detail(400, 0)).includes('blurry'));
  assert.ok(gateFlags(detail(900, 10.01)).includes('noisy'));
  assert.ok(!gateFlags(detail(900, 10)).includes('noisy'));
  for (const quality of [null, .4, .7]) {
    assert.ok(!gateFlags(detail(1, 20, quality)).some(f => ['blurry', 'noisy'].includes(f)));
  }
  assert.deepEqual(gateFlags({ metrics: { quality: .1 } }), []);
});
test('dark style alone is retained; calibrated darkness requires destroyed shadows', () => {
  assert.ok(!gateFlags({ metrics: { raw: { meanLuma: 20 }, clippedShadows: .001 } }).includes('underexposed'));
  assert.ok(gateFlags({ metrics: { raw: { meanLuma: 59, lumaVariance: 900 }, clippedShadows: .02 } }).includes('underexposed'));
  assert.ok(!gateFlags({ metrics: { raw: { meanLuma: 60, lumaVariance: 900 }, clippedShadows: .02 } }).includes('underexposed'));
});
test('measurement violations change the winner without rejecting composition choices', () => {
  const safe = { unitId: 'safe', metrics: { quality: .6 }, verdicts: [] };
  const crop = { unitId: 'crop', metrics: { quality: .605 }, verdicts: [
    { ruleId: 'P-CROP-WRIST', by: 'measure', verdict: 'violate', evidence: '腕碰边' },
    { ruleId: 'P-CROP-WRIST', by: 'measure', verdict: 'violate', evidence: '第二人' },
  ] };
  assert.equal(rulePenalty(crop), .01);
  const ranked = rankGroup([safe, crop]);
  assert.equal(ranked[0].unitId, 'safe');
  assert.equal(suggestDecision(ranked[1], crop, 2), 'candidate');
  assert.ok(ranked[1].reasons.some(r => r.includes('规则扣分 P-CROP-WRIST')));
  const single = rankGroup([crop])[0];
  assert.equal(single.score, .605);
  assert.equal(suggestDecision(single, crop, 1), 'selected');
});
test('warnings, hints, unknowns and non-measure judgments never change ranking', () => {
  for (const verdict of ['warn', 'hint', 'na', 'pass']) {
    const item = { unitId: 'b', metrics: { quality: .61 }, verdicts: [
      { ruleId: 'P-CROP-HAIRLINE', by: 'measure', verdict, evidence: verdict },
    ] };
    assert.equal(rulePenalty(item), 0);
    assert.equal(rankGroup([{ unitId: 'a', metrics: { quality: .6 } }, item])[0].unitId, 'b');
  }
  assert.equal(rulePenalty({ verdicts: [{ ruleId: 'P-CROP-HAIRLINE', by: 'vlm', verdict: 'violate' }] }), 0);
});
test('severe measurable clipping and tilt violate, softer values only warn', () => {
  const signals = { persons: [{ isMain: true, faceClippedHighlights: .09, faceClippedShadows: 0,
    faceExposurePixels: 100 }], imageMeasurements: { version: 'measure-v3', horizontalTiltDegrees: 6,
    horizontalLineConfidence: .8 } };
  const verdicts = evaluateRules(signals);
  assert.equal(verdicts.find(v => v.ruleId === 'P-EXPOSURE-INTENT').verdict, 'violate');
  assert.equal(verdicts.find(v => v.ruleId === 'L-HORIZON-LEVEL').verdict, 'violate');
  signals.persons[0].faceClippedHighlights = .04;
  signals.imageMeasurements.horizontalTiltDegrees = 3;
  const softer = evaluateRules(signals);
  assert.equal(softer.find(v => v.ruleId === 'P-EXPOSURE-INTENT').verdict, 'warn');
  assert.equal(softer.find(v => v.ruleId === 'L-HORIZON-LEVEL').verdict, 'warn');
});

test('a normally exposed measured face protects bright backgrounds and dark night scenes', () => {
  const metrics = { clippedHighlights: .3, clippedShadows: .2, raw: { meanLuma: 20, lumaVariance: 900,
    faceExposure: { clippedHigh: 0, clippedLow: 0, meanLuma: 90 } } };
  assert.deepEqual(gateFlags({ metrics }), []);
  delete metrics.raw.faceExposure;
  assert.ok(gateFlags({ metrics }).includes('overexposed'));
  assert.ok(gateFlags({ metrics }).includes('underexposed'));
});

test('high contrast night scenes retain information and do not trigger the scene darkness gate', () => {
  assert.ok(!gateFlags({ metrics: { clippedShadows: .2, raw: { meanLuma: 40, lumaVariance: 1000 } } })
    .includes('underexposed'));
  assert.ok(!gateFlags(detail(20, 0, .236)).includes('blurry'), 'low texture sunset needs review, not rejection');
});

test('matched measured face highlights can gate without relying on rule verdicts', () => {
  const item = { signals: { imageMeasurements: { version: 'measure-v3' }, persons: [
    { isMain: true, faceExposurePixels: 100, faceClippedHighlights: .1 },
  ] }, verdicts: [] };
  assert.ok(gateFlags(item).includes('overexposed'));
  item.signals.persons[0].faceExposurePixels = 63;
  item.verdicts = [{ by: 'measure', ruleId: 'P-EXPOSURE-INTENT', verdict: 'violate' }];
  assert.deepEqual(gateFlags(item), []);
  item.signals.persons[0].faceExposurePixels = 100;
  item.signals.persons[0].isMain = false;
  assert.deepEqual(gateFlags(item), []);
});
