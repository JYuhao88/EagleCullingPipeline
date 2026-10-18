import test from 'node:test';
import assert from 'node:assert/strict';
import { cutText, locatedIssues, photoFacts } from '../src/core/photo-facts.js';

const points = Array.from({ length: 133 }, () => [0.5, 0.5, 0.9]);
const person = (extra = {}) => ({ isMain: true, box: [0.2, 0.1, 0.8, 0.95], keypoints: { points }, ...extra });

test('cut text says whether the joint is past the edge or just touching it', () => {
  assert.equal(cutText({ edge: 'bottom', joint: 'knee', side: 'left', distanceHeads: -0.05 }), '左膝盖被画面下边切掉');
  assert.equal(cutText({ edge: 'right', joint: 'wrist', side: 'right', distanceHeads: 0.02 }), '画面右边卡在右手腕附近');
});

test('a crop verdict only marks the joints of its own rule', () => {
  const result = {
    signals: { persons: [person({ edgeAtJoint: [
      { edge: 'bottom', joint: 'foot', side: 'left', distanceHeads: -0.07 },
      { edge: 'left', joint: 'fingers', side: 'right', distanceHeads: -0.08 }] })] },
    verdicts: [{ ruleId: 'P-CROP-WRIST', verdict: 'violate', personIndex: 0 }],
  };
  assert.deepEqual(locatedIssues(result).map(issue => issue.text), ['右手指被画面左边切掉']);
  assert.deepEqual(photoFacts(result).cuts, ['手']);
});

test('closed eyes count only on the main subject face', () => {
  const background = { box: [0.85, 0.1, 0.95, 0.2], eyesClosed: true, eyeBoxes: [[0.86, 0.12, 0.88, 0.13]] };
  const main = { box: [0.4, 0.15, 0.55, 0.3], eyesClosed: false, eyeBoxes: [[0.42, 0.2, 0.45, 0.21]] };
  const result = { faces: [background, main], signals: { persons: [person()] },
    verdicts: [{ ruleId: 'P-FACE-EYES', verdict: 'warn', personIndex: 0 }] };
  assert.equal(locatedIssues(result).length, 0);
  assert.equal(photoFacts({ ...result, verdicts: [{ ruleId: 'P-FACE-EYES', verdict: 'pass', personIndex: 0 }] }).eyes, 'open');
});

test('facts stay unknown without a main subject or a measurement', () => {
  const facts = photoFacts({ verdicts: [{ ruleId: 'L-HORIZON-LEVEL', verdict: 'violate' }] });
  assert.equal(facts.eyes, null);
  assert.equal(facts.cuts, null);
  assert.equal(facts.subjectLuma, null);
  assert.equal(facts.tilted, true);
  assert.equal(facts.blur, null);
});

test('blur and tilt require assessed verdicts and do not turn NA or warnings into a negative', () => {
  const facts = verdicts => photoFacts({ verdicts });
  assert.equal(facts([{ ruleId: 'G-PROXY-BLUR', verdict: 'pass' }]).blur, false);
  assert.equal(facts([{ ruleId: 'G-PROXY-BLUR', verdict: 'warn' }]).blur, true);
  assert.equal(facts([{ ruleId: 'G-PROXY-BLUR', verdict: 'na' }]).blur, null);
  assert.equal(facts([{ ruleId: 'L-HORIZON-LEVEL', verdict: 'na' }]).tilted, null);
  assert.equal(facts([{ ruleId: 'L-HORIZON-LEVEL', verdict: 'warn' }]).tilted, null);
  assert.equal(facts([{ ruleId: 'L-HORIZON-LEVEL', verdict: 'pass' }]).tilted, false);
  assert.equal(facts([{ ruleId: 'L-HORIZON-LEVEL', verdict: 'pass' },
    { ruleId: 'L-VERTICAL-LEVEL', verdict: 'warn' }]).tilted, null);
});