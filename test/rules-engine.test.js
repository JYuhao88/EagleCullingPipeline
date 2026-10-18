import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { evaluateRules } from '../src/core/rules-engine.js';

test('rule libraries are well-formed', async () => {
  const dir = new URL('../src/rules/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  const ids = new Set();
  for (const file of files) {
    const library = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    assert.equal(library.contractVersion, 1, file);
    for (const rule of library.rules) {
      assert.match(rule.id, /^[A-Z]+(-[A-Z0-9]+)+$/, rule.id);
      assert.ok(!ids.has(rule.id), `duplicate ${rule.id}`);
      ids.add(rule.id);
      assert.ok(rule.title && rule.statement && rule.aspect, rule.id);
      assert.ok(['gate', 'penalty', 'hint'].includes(rule.severity), rule.id);
      assert.ok(['measure', 'teacher', 'measure+teacher'].includes(rule.check?.by), rule.id);
      assert.ok(rule.sources?.length, rule.id);
    }
  }
});

function person(overrides = {}) {
  return { box: [0.2, 0.1, 0.8, 0.95], isMain: true, headHeight: 0.12,
    headroomHeads: 0.4, edgeAtJoint: [], framingTier: 'full',
    keypoints: { format: 'coco-wholebody-133', points: Array.from({ length: 133 }, () => [0.5, 0.5, 0.9]) },
    shoulderTilt: -4, hipTilt: 3, shoulderHipAngle: 7, ...overrides };
}
const face = { box: [0.4, 0.15, 0.6, 0.3], eyesAssessed: true, eyesClosed: false };
function verdict(id, subject = person(), faces = [face]) {
  return evaluateRules({ persons: [subject] }, { faces }).find((result) => result.ruleId === id);
}

const cropRules = [
  ['P-CROP-HAIRLINE', 'hairline', 'top'], ['P-CROP-NECK', 'neck', 'bottom'],
  ['P-CROP-WRIST', 'wrist', 'left'], ['P-CROP-KNEE', 'knee', 'bottom'],
  ['P-CROP-ANKLE-FOOT', 'ankle', 'bottom'],
];
for (const [id, joint, edge] of cropRules) {
  test(`${id}: measured pass and near-edge violation`, () => {
    assert.equal(verdict(id).verdict, 'pass');
    const result = verdict(id, person({ edgeAtJoint: [{ joint, edge, side: 'left', distanceHeads: 0.04 }] }));
    assert.equal(result.verdict, 'violate');
    assert.match(result.evidence, /0\.04 头高/);
    assert.deepEqual(Object.keys(result).sort(), ['by', 'contractVersion', 'evidence', 'personIndex', 'ruleId', 'rulesVersion',
      'verdict'].sort());
    assert.equal(result.rulesVersion, 'portrait@0.1.0');
    assert.equal(result.by, 'measure');
  });
}

test('headroom abstains without same-group same-framing context', () => {
  for (const headroomHeads of [0, .1, .3, .4, .6, 1.2, 1.3])
    assert.equal(verdict('P-CROP-HEADROOM', person({ headroomHeads })).verdict, 'na');
});

test('framing: every permitted tier passes; dangerous crop violates', () => {
  for (const framingTier of ['chest', 'waist', 'thigh', 'full'])
    assert.equal(verdict('P-CROP-TIER', person({ framingTier })).verdict, 'pass');
  for (const framingTier of ['knee-cut', 'other', 'ankle-cut'])
    assert.equal(verdict('P-CROP-TIER', person({ framingTier })).verdict, 'violate');
});

test('eyes: only the main subject is assessed', () => {
  assert.equal(verdict('P-FACE-EYES').verdict, 'pass');
  assert.equal(verdict('P-FACE-EYES', person(), [{ ...face, eyesClosed: true }]).verdict, 'violate');
  const background = { box: [0, 0, 0.15, 0.25], eyesAssessed: true, eyesClosed: true };
  assert.equal(verdict('P-FACE-EYES', person(), [background, face]).verdict, 'pass');
  assert.equal(verdict('P-FACE-EYES', person(), [background]).verdict, 'na');
  assert.equal(verdict('P-FACE-EYES', person(), [{ ...face, eyesAssessed: false }]).verdict, 'na');
  assert.equal(verdict('P-FACE-EYES', person(), [{ ...face, eyesClosed: undefined }]).verdict, 'na');
});

test('unimplemented measurements remain na even if supplied', () => {
  const result = evaluateRules({ persons: [person({ limbForeshortening: 1, limbOcclusion: 1, eyeSharpnessNative: 1, afPointOnEye:
    true, faceClippedHighlights: 1, faceClippedShadows: 1 })] });
  for (const id of ['P-HAND-WIDEANGLE', 'P-POSE-LIMB-HIDDEN', 'P-FACE-FOCUS', 'P-EXPOSURE-INTENT'])
    assert.equal(result.find((entry) => entry.ruleId === id).verdict, 'na');
  assert.ok(result.every((entry) => entry.by === 'measure'));
  assert.ok(!result.some((entry) => entry.ruleId === 'P-HAND-NATURAL'));
});

test('pose has no numeric pass/violate thresholds and reports a review hint', () => {
  const result = verdict('P-POSE-WEIGHT');
  assert.equal(result.verdict, 'warn');
  assert.match(result.evidence, /肩倾 -4\.00°/);
  assert.equal(verdict('P-POSE-WEIGHT', person({ hipTilt: undefined })).verdict, 'na');
});

test('missing measurements and low-confidence joints yield na, not pass', () => {
  assert.equal(verdict('P-CROP-HEADROOM', person({ headroomHeads: undefined })).verdict, 'na');
  assert.equal(verdict('P-CROP-TIER', person({ framingTier: undefined })).verdict, 'na');
  assert.equal(verdict('P-CROP-KNEE', person({ edgeAtJoint: undefined })).verdict, 'na');
  const lowConfidence = person({ keypoints: { points: Array.from({ length: 133 }, () => [0.5, 0.5, 0.1]) } });
  assert.equal(verdict('P-CROP-KNEE', lowConfidence).verdict, 'na');
  assert.equal(verdict('P-CROP-WRIST', lowConfidence).verdict, 'na');
  assert.ok(evaluateRules({ persons: [] }).every((entry) => entry.verdict === 'na' && entry.personIndex === undefined));
  assert.ok(evaluateRules(undefined).every((entry) => entry.verdict === 'na'));
});

test('outside joint evidence and nonmatching edges', () => {
  const subject = person({ edgeAtJoint: [{ joint: 'knee', edge: 'bottom', side: 'right', distanceHeads: -0.2 }] });
  assert.equal(verdict('P-CROP-KNEE', subject).evidence, '右膝越过下沿');
  assert.equal(verdict('P-CROP-HAIRLINE', subject).verdict, 'pass');
  assert.equal(verdict('P-CROP-KNEE', person({ edgeAtJoint: [{ joint: 'knee', edge: 'left', distanceHeads: 0 }] })).verdict, 'pass');
});

test('every main subject gets verdicts with its original personIndex', () => {
  const results = evaluateRules({ persons: [person({ isMain: false }), person(), person({ headroomHeads: 0 })] });
  const headroom = results.filter((entry) => entry.ruleId === 'P-CROP-HEADROOM');
  assert.deepEqual(headroom.map((entry) => [entry.personIndex, entry.verdict]), [[1, 'na'], [2, 'na']]);
});

test('custom rule library keeps its own version and teacher parts are omitted', () => {
  const rules = { library: 'custom', version: '2', rules: [
    { id: 'CUSTOM', check: { by: 'measure+teacher', signal: 'headroomHeads', pass: [0, 1], warn: [-1, 2] } },
    { id: 'TEACHER', check: { by: 'teacher' } },
  ] };
  assert.deepEqual(evaluateRules({ persons: [person()] }, { rules }).map((entry) => [entry.ruleId, entry.rulesVersion,
    entry.verdict]), [['CUSTOM', 'custom@2', 'pass']]);
});

test('high-score border-compressed lower limbs remain na rather than fabricated pass', () => {
  const subject=person();
  for(const [hip,knee,ankle,foot] of [[11,13,15,17],[12,14,16,20]]) {
    subject.keypoints.points[hip]=[.5,.6,.95];
    subject.keypoints.points[knee]=[.5,.96,.95];
    subject.keypoints.points[ankle]=[.5,.99,.95];
    for(let i=foot;i<foot+3;i++)subject.keypoints.points[i]=[.5,.995,.95];
  }
  assert.equal(verdict('P-CROP-KNEE',subject).verdict,'na');
  assert.equal(verdict('P-CROP-ANKLE-FOOT',subject).verdict,'na');
});

test('unknown future measurement signals remain na even if present', () => {
  const rules={library:'future',version:'1',rules:[{id:'unknown',check:{by:'measure',signal:'unsupportedNewSignal'}}]};
  assert.equal(evaluateRules({persons:[person({unsupportedNewSignal:1})]},{rules})[0].verdict,'na');
});
