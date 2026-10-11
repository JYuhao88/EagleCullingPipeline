import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/core/rules-engine.js';

const image = {
  version: 'measure-v3', clippedHighlights: .001, clippedShadows: .001, laplacianVariance: 400,
  horizontalLineConfidence: 1, verticalLineConfidence: 1, grayWorldPixels: 200,
  grayWorldDeviation: .05, edgeGradientRatio: 1, horizontalTiltDegrees: .5, verticalTiltDegrees: .5,
};
const person = {
  isMain: true, box: [.2, .1, .8, .9], subjectAreaRatio: .48, subjectAnchorDistance: 0,
  faceClippedHighlights: .001, faceClippedShadows: .001, faceExposurePixels: 100,
};
function run(id, overrides = {}, subjects = [person], options = {}) {
  return evaluateRules({ imageMeasurements: { ...image, ...overrides }, persons: subjects }, options)
    .find((result) => result.ruleId === id);
}
const imageCases = [
  ['L-EXPOSURE-DETAIL', 'clippedHighlights', .1], ['L-SHADOW-RECOVERY', 'clippedShadows', .2],
  ['S-EXPOSURE-CONTENT', 'clippedHighlights', .1], ['L-HORIZON-LEVEL', 'horizontalTiltDegrees', -4],
  ['L-VERTICAL-LEVEL', 'verticalTiltDegrees', 5], ['S-TILT-INTENT', 'verticalTiltDegrees', -5],
  ['G-EDGE-GRADIENT', 'edgeGradientRatio', 3],
  ['G-PROXY-BLUR', 'laplacianVariance', 10],
];
for (const [id, signal, value] of imageCases) {
  test(`${id}: proxy measurement passes, warns, and abstains without a valid signal`, () => {
    assert.equal(run(id).verdict, 'pass');
    const triggered = run(id, { [signal]: value }, []);
    assert.equal(triggered.verdict, 'warn');
    assert.match(triggered.evidence, /measure-v3/);
    assert.ok(triggered.evidence.includes(signal));
    assert.ok(triggered.evidence.includes(value.toFixed(4)));
    assert.equal(triggered.personIndex, undefined);
    for (const missing of [undefined, NaN, Infinity]) assert.equal(run(id, { [signal]: missing }).verdict, 'na');
    assert.equal(run(id, { version: 'measure-v2' }).verdict, 'na');
  });
}

test('image-scoped measurements occur once even with several main people', () => {
  const results = evaluateRules({ imageMeasurements: image, persons: [person, person, person] });
  assert.equal(results.filter(({ ruleId }) => ruleId === 'G-PROXY-BLUR').length, 1);
  assert.equal(results.filter(({ ruleId }) => ruleId === 'P-SUBJECT-PLACEMENT').length, 3);
});

test('face exposure uses only the subject face region and abstains on small or unversioned samples', () => {
  const id = 'P-EXPOSURE-INTENT';
  assert.equal(run(id, { clippedHighlights: 1 }).verdict, 'pass');
  for (const faceFields of [{ faceClippedHighlights: .2 }, { faceClippedShadows: .7 }]) {
    const result = run(id, {}, [{ ...person, ...faceFields }]);
    assert.equal(result.verdict, faceFields.faceClippedHighlights ? 'violate' : 'warn');
    assert.match(result.evidence, /ratio/);
  }
  assert.equal(run(id, {}, [{ ...person, faceExposurePixels: 63 }]).verdict, 'na');
  assert.equal(run(id, {}, [{ ...person, faceExposurePixels: 64 }]).verdict, 'pass');
  assert.equal(run(id, {}, [{ ...person, faceExposurePixels: undefined }]).verdict, 'na');
  assert.equal(run(id, { version: undefined }).verdict, 'na');
  assert.equal(run(id, {}, []).verdict, 'na');
});

test('subject placement only hints, retains per-person identity, and rejects invalid ratios', () => {
  const id = 'P-SUBJECT-PLACEMENT';
  assert.equal(run(id).verdict, 'pass');
  for (const fields of [{ subjectAreaRatio: .01 }, { subjectAnchorDistance: .3 }])
    assert.equal(run(id, {}, [{ ...person, ...fields }]).verdict, 'warn');
  assert.equal(run(id, {}, [{ ...person, subjectAreaRatio: -.1 }]).verdict, 'na');
  assert.equal(run(id, {}, [{ ...person, subjectAnchorDistance: undefined }]).verdict, 'na');
});

test('endpoint thresholds depend on genre and clipping remains a warning', () => {
  assert.equal(run('L-EXPOSURE-DETAIL', { clippedHighlights: .05 }).verdict, 'warn');
  assert.equal(run('S-EXPOSURE-CONTENT', { clippedHighlights: .05 }).verdict, 'pass');
  assert.equal(run('L-SHADOW-RECOVERY', { clippedShadows: .15 }).verdict, 'warn');
  assert.equal(run('S-EXPOSURE-CONTENT', { clippedShadows: .15 }).verdict, 'pass');
  assert.equal(run('S-EXPOSURE-CONTENT', { clippedHighlights: 1, clippedShadows: 1 }).verdict, 'warn');
});

test('genre filtering selects only matching libraries and shared image measurements', () => {
  const results = evaluateRules({ imageMeasurements: image, persons: [person] }, { genres: 'landscape' });
  assert.ok(results.some(({ ruleId }) => ruleId === 'L-HORIZON-LEVEL'));
  assert.ok(results.some(({ ruleId }) => ruleId === 'G-PROXY-BLUR'));
  assert.ok(!results.some(({ ruleId }) => ruleId.startsWith('P-') || ruleId.startsWith('S-')));
});

test('joint observability prevents unseen sides from becoming a safe pass; elbow crop is measurable', () => {
  const subject = { ...person, edgeAtJoint: [], jointObservability: { elbow: false, knee: false, wrist: false } };
  assert.equal(run('P-CROP-ELBOW', {}, [subject]).verdict, 'na');
  assert.equal(run('P-CROP-KNEE', {}, [subject]).verdict, 'na');
  assert.equal(run('P-CROP-ELBOW', {}, [{ ...subject, jointObservability: { elbow: true } }]).verdict, 'pass');
  const hit = { joint: 'elbow', edge: 'left', side: 'left', distanceHeads: .04 };
  const result = run('P-CROP-ELBOW', {}, [{ ...subject, edgeAtJoint: [hit] }]);
  assert.equal(result.verdict, 'violate');
  assert.match(result.evidence, /肘 0.04 头高/);
});


test('relative hints abstain without context, and weak line/color supports abstain', () => {
  assert.equal(run('P-CROP-HEADROOM', {}, [{ ...person, headroomHeads: 2 }]).verdict, 'na');
  assert.equal(run('P-CROP-HEADROOM', {}, [{ ...person, headroomHeads: .4 }]).verdict, 'na');
  assert.equal(run('L-HORIZON-LEVEL', { horizontalLineConfidence: .5 }).verdict, 'na');
  assert.equal(run('L-VERTICAL-LEVEL', { verticalLineConfidence: .5 }).verdict, 'na');
  assert.equal(run('P-COLOR-CAST', { grayWorldPixels: 63 }).verdict, 'na');
});
