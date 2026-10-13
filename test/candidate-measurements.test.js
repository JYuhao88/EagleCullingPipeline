import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { candidatePixels, candidatePerson, measureCandidates,
  evaluateCandidateRules, CANDIDATE_CONFIG } from '../src/core/candidate-measurements.js';
import { skyExposure } from '../src/core/metrics.js';
import { evaluateRules } from '../src/core/rules-engine.js';
import { rankGroup, gateFlags, rulePenalty } from '../src/core/ranking.js';
import { validateRuleVerdict } from '../src/core/contracts.js';

const size = 96;
const person = { box: [.25, .1, .75, .98], score: .9, isMain: true };
const signals = { contractVersion: 1, persons: [person], imageMeasurements: { version: 'measure-v3',
  horizontalTiltDegrees: 6, horizontalLineConfidence: .9 } };
const raster = fn => Buffer.from(Array.from({ length: size * size * 3 }, (_, i) =>
  fn(Math.floor(i / 3) % size, Math.floor(i / 3 / size))[i % 3]));
const measure = (fn, context = {}) => candidatePixels(raster(fn), size, size, { signals, ...context });
const verdict = (m, id) => evaluateCandidateRules(m, signals).find(v => v.ruleId === id).verdict;

test('contrast compression measures range/local contrast; night/high/low key abstain', () => {
  const rich = measure((x, y) => Array(3).fill(40 + ((x + y) % 64) * 3));
  const flat = measure((x, y) => Array(3).fill(120 + ((x + y) % 64) * .1));
  assert.ok(rich.tonal.range > flat.tonal.range);
  assert.equal(verdict(rich, 'P-YD-TONAL-GRAY'), 'pass');
  assert.equal(verdict(flat, 'P-YD-TONAL-GRAY'), 'violate');
  for (const mean of [10, 35, 230]) assert.equal(verdict(measure(() => [mean, mean, mean]), 'P-YD-TONAL-GRAY'), 'na');
  assert.equal(verdict(measure(() => [128,128,128], { metrics: { quality: .9 } }), 'P-YD-TONAL-GRAY'), 'na');
  assert.equal(measure(() => [128,128,128], { metrics: { quality: null } }).tonal.eligible, true);
});

test('nonface highlight fraction excludes face and sky; high key and unreliable boxes abstain', () => {
  const face = { box: [.35, .15, .65, .35], confidence: .9 };
  const facesOnly = measure((x,y) => (x+.5)/size>=.35 && (x+.5)/size<.65 && (y+.5)/size>=.15 && (y+.5)/size<.35 ? [255,255,255] :
    [100,100,100], { faces: [face] });
  assert.equal(facesOnly.highlights.fraction, 0);
  const sky = measure((x,y) => y<7 ? [255,255,255] : [100,100,100]);
  // sky-v1 leaves the high-gradient boundary row unmasked.
  assert.ok(sky.highlights.fraction < CANDIDATE_CONFIG.highlights.warnFraction);
  assert.equal(verdict(sky, 'P-YD-NONFACE-HIGHLIGHTS'), 'pass');
  const blownClothes = measure((x,y) => x>28 && x<68 && y>45 && y<75 ? [255,255,255] :
    [100,100,100], { faces: [face] });
  assert.equal(verdict(blownClothes, 'P-YD-NONFACE-HIGHLIGHTS'), 'violate');
  assert.equal(verdict(measure(() => [255,255,255]), 'P-YD-NONFACE-HIGHLIGHTS'), 'na');
  assert.equal(verdict(measure(() => [100,100,100], { signals: { persons: [{ ...person, score: .1 }] } }),
    'P-YD-NONFACE-HIGHLIGHTS'), 'na');
});

test('side bands compare luminance and color; silhouette, high/low key and absent person abstain', () => {
  const flat = measure(() => [128,128,128]);
  assert.equal(verdict(flat, 'P-YD-BG-SEPARATION'), 'violate');
  const distinct = measure(x => x>=24 && x<72 ? [80,150,90] : [180,80,150]);
  assert.equal(verdict(distinct, 'P-YD-BG-SEPARATION'), 'pass');
  const silhouette = measure(x => x>=24 && x<72 ? [10,10,10] : [180,180,180]);
  assert.equal(verdict(silhouette, 'P-YD-BG-SEPARATION'), 'na');
  for (const mean of [10,230]) assert.equal(verdict(measure(() => [mean,mean,mean]), 'P-YD-BG-SEPARATION'), 'na');
  assert.equal(verdict(measure(() => [100,100,100], { signals: { persons: [] } }), 'P-YD-BG-SEPARATION'), 'na');
  assert.equal(candidatePerson({ persons: [{ ...person, box: [0,0,1,1] }] }), undefined);
  assert.equal(candidatePerson({ persons: [{ ...person, box: [.25,0,.75,1] }] }).score, .9);
});

test('tilt is mapping of existing thresholds and missing lines abstain', () => {
  const m = measure(() => [128,128,128]);
  assert.equal(verdict(m, 'P-YD-TILT'), 'violate');
  for (const [angle, conf, expected] of [[1,.9,'pass'],[3,.9,'warn'],[6,.2,'na'],[21,.9,'na']]) {
    const s = { imageMeasurements: { version:'measure-v3', horizontalTiltDegrees:angle, horizontalLineConfidence:conf } };
    assert.equal(evaluateCandidateRules(m,s).find(v=>v.ruleId==='P-YD-TILT').verdict, expected);
  }
  assert.deepEqual(evaluateCandidateRules({ version:'old' },signals), []);
  const missing = evaluateCandidateRules({ version: CANDIDATE_CONFIG.version }, {});
  assert.ok(missing.every(v => v.verdict === 'na'));
});

test('hints conform to contract and never change scores/penalties/gates', () => {
  const m = measure(() => [128,128,128]);
  const base = { unitId:'a', metrics:{ quality:.6, sharpness:.2, exposure:.9 }, flags:[], signals };
  const candidate = structuredClone(base);
  candidate.signals.imageMeasurements.candidates = m;
  const before = rankGroup([structuredClone(base), { unitId:'b', metrics:base.metrics, flags:[] }]);
  const after = rankGroup([candidate, { unitId:'b', metrics:base.metrics, flags:[] }]);
  assert.deepEqual(before.map(v=>[v.unitId,v.score]), after.map(v=>[v.unitId,v.score]));
  assert.deepEqual(gateFlags(base), gateFlags(candidate));
  assert.equal(rulePenalty({ ...base, verdicts: evaluateRules(base.signals) }), rulePenalty(candidate));
  const rows = evaluateCandidateRules(m,signals);
  assert.ok(rows.every(validateRuleVerdict));
  assert.equal(evaluateRules(signals).some(v=>v.ruleId.startsWith('P-YD')), false);
  assert.equal(evaluateRules(candidate.signals).filter(v=>v.ruleId.startsWith('P-YD')).length, 4);
});

test('sky-v1 mask opt-in preserves old exposure values; async raster agrees with pure measurement', async () => {
  const luma = Array.from({length:96*96},(_,i)=>i<96*10?255:100);
  const old = skyExposure(luma,96,96), expanded = skyExposure(luma,96,96,undefined,{includeMask:true});
  const { mask, ...values } = expanded;
  assert.deepEqual(values,old);
  assert.equal(mask.reduce((s,v)=>s+v,0),96*9);
  const pixels = raster(()=>[128,128,128]);
  const png = await sharp(pixels,{raw:{width:size,height:size,channels:3}}).png().toBuffer();
  const result = await measureCandidates(png,{ signals });
  assert.equal(result.version,CANDIDATE_CONFIG.version);
  assert.equal(result.tonal.range,0);
  assert.equal(result.separation.weakFraction,1);
});
