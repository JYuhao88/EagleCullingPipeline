import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleObservations } from '../src/core/observations-rules.js';

const point = (x, y, confidence = 0.9) => [x, y, confidence];
const basePoints = () => Array.from({ length: 133 }, () => point(0.5, 0.5));
const main = (extra = {}) => ({ isMain: true, box: [0.2, 0.1, 0.8, 0.9], keypoints: { points: basePoints() }, ...extra });
const face = (extra = {}) => ({ box: [0.4, 0.18, 0.6, 0.36], eyeBoxes: [[0.44, 0.23, 0.48, 0.25], [0.52, 0.23, 0.56, 0.25]], ...extra });
const result = (person = main(), faces = [face()], extra = {}) => ({
  source: { width: 1000, height: 1000 }, signals: { persons: [person] }, faces, ...extra,
});
const setFacePoints = (person, { nose = [0.5, 0.28], leftEye = [0.46, 0.24], rightEye = [0.54, 0.24],
  leftEar = [0.38, 0.24], rightEar = [0.62, 0.24] } = {}) => {
  const points = person.keypoints.points;
  points[0] = point(...nose); points[1] = point(...leftEye); points[2] = point(...rightEye);
  points[3] = point(...leftEar); points[4] = point(...rightEar);
  return person;
};
const focusResult = (kind = 'eye') => {
  const person = setFacePoints(main({ keypoints: { points: Array.from({ length: 133 }, () => point(0, 0, 0)) },
    faceExposurePixels: 128, faceClippedHighlights: 0.01, faceClippedShadows: 0.01 }));
  return result(person, [face()], { focus: { status: 'ok', afSource: 'FocusLocation',
    afPoint: kind === 'eye' ? [0.46, 0.24] : [0.5, 0.285],
    afFrame: kind === 'eye' ? [0.445, 0.232, 0.475, 0.248] : [0.485, 0.27, 0.515, 0.3],
    afPointOnEye: kind === 'eye', afPointOnSubject: true } });
};
const focusObservations = value => ruleObservations(value).filter(item => item.id.startsWith('focus-'));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('reports a visible background person with its box, but ignores a tiny distant person', () => {
  const person = main();
  const other = { box: [0.02, 0.55, 0.18, 0.9], keypoints: { points: basePoints() } };
  const observations = ruleObservations({ ...result(person), signals: { persons: [person, other] } });
  assert.deepEqual(observations.filter(observation => observation.id === 'background-person')
    .map(observation => observation.text), ['左下有路人入镜']);
  assert.deepEqual(observations.find(observation => observation.id === 'background-person').box, other.box);
  const tiny = { box: [0.45, 0.8, 0.49, 0.84], keypoints: { points: basePoints() } };
  assert.equal(ruleObservations({ ...result(person), signals: { persons: [person, tiny] } })
    .some(observation => observation.id === 'background-person'), false);
});

test('same-scale people are reported as a group instead of background people', () => {
  const person = main();
  const peer = { box: [0.05, 0.1, 0.65, 0.9], keypoints: { points: basePoints() } };
  const observations = ruleObservations({ ...result(person), signals: { persons: [person, peer] } });
  assert.deepEqual(observations.filter(observation => observation.id === 'multiple-people').map(observation => observation.text), ['多人同框']);
  assert.equal(observations.some(observation => observation.id === 'background-person'), false);
});

test('reports frontal and side faces only with reliable face geometry; lowered heads stay silent', () => {
  const frontal = setFacePoints(main());
  assert.equal(ruleObservations(result(frontal)).find(observation => observation.id.startsWith('face-')).text, '正脸');
  const side = setFacePoints(main(), { nose: [0.57, 0.28], leftEye: [0.45, 0.24], rightEye: [0.49, 0.24], rightEar: [0.7, 0.24] });
  side.keypoints.points[4][2] = 0.2;
  assert.equal(ruleObservations(result(side)).find(observation => observation.id.startsWith('face-')).text, '侧脸');
  const down = setFacePoints(main(), { nose: [0.5, 0.36] });
  assert.equal(ruleObservations(result(down)).find(observation => observation.id.startsWith('face-'))?.text, '正脸');
  const uncertain = setFacePoints(main()); uncertain.keypoints.points[3][2] = 0.4;
  assert.equal(ruleObservations(result(uncertain)).some(observation => observation.id.startsWith('face-')), false);
});

test('reports hand-near-face but never hands on hips', () => {
  const hand = setFacePoints(main());
  for (const index of [91, 92, 93]) hand.keypoints.points[index] = point(0.5, 0.28);
  assert.equal(ruleObservations(result(hand)).some(observation => observation.id === 'hand-near-face'), true);

  const hips = setFacePoints(main());
  const points = hips.keypoints.points;
  points[5] = point(0.4, 0.4); points[6] = point(0.6, 0.4); points[11] = point(0.4, 0.7); points[12] = point(0.6, 0.7);
  points[9] = point(0.25, 0.68); points[7] = point(0.3, 0.55);
  assert.equal(ruleObservations(result(hips)).some(observation => observation.id === 'hands-on-hips'), false);
});

test('closed eyes come from the existing main-subject verdict and low confidence stays silent', () => {
  const person = setFacePoints(main());
  const closed = result(person, [face({ eyesClosed: true })], { verdicts: [{ ruleId: 'P-FACE-EYES', verdict: 'warn', personIndex: 0 }] });
  const observation = ruleObservations(closed).find(item => item.id === 'eyes-closed');
  assert.equal(observation.text, '主体闭眼');
  assert.deepEqual(observation.box, [0.44, 0.23, 0.56, 0.25]);
  const weak = setFacePoints(main()); weak.keypoints.points[0][2] = 0.4;
  assert.equal(ruleObservations(result(weak)).some(item => item.id.startsWith('face-')), false);
});

for (const kind of ['eye']) {
  test(`reports the ${kind} AF location with a short display-only rule observation`, () => {
    const value = focusResult(kind);
    assert.deepEqual(focusObservations(value), [{ id: `focus-${kind}`,
      text: kind === 'eye' ? '对焦点在眼部' : '对焦点在脸部', tone: 'neutral', source: 'rule', box: value.focus.afFrame }]);
    for (const observation of ruleObservations(value)) {
      assert.ok([...observation.text].length <= 12);
      assert.equal(observation.source, 'rule');
      assert.equal(Object.hasOwn(observation, 'confidence'), false);
    }
    assert.equal(ruleObservations(value).some(item => item.id === 'hand-near-face'), false);
  });

  const missingFocus = {
    missing: value => { delete value.focus; }, null: value => { value.focus = null; },
    unavailable: value => { value.focus.status = 'na'; }, unknown: value => { value.focus.status = 'pending'; },
    'missing status': value => { delete value.focus.status; },
  };
  for (const [name, change] of Object.entries(missingFocus)) test(`${kind} AF abstains with ${name} focus`, () => {
    const value = focusResult(kind); change(value);
    assert.deepEqual(focusObservations(value), []);
  });

  for (const source of [undefined, null, '', 'sony-FocusLocation', 'AFPoint', 'FocusPosition'])
    test(`${kind} AF abstains with unsupported source ${String(source)}`, () => {
      const value = focusResult(kind); value.focus.afSource = source;
      assert.deepEqual(focusObservations(value), []);
    });

  const invalidPoints = [undefined, null, [], [0.46], [0.46, 0.24, 0.9], ['0.46', 0.24],
    [NaN, 0.24], [Infinity, 0.24], [-0.01, 0.24], [1.01, 0.24], [0.46, -0.01], [0.46, 1.01], [0.7, 0.7]];
  invalidPoints.forEach((afPoint, index) => test(`${kind} AF abstains with invalid/outside-frame point ${index}`, () => {
    const value = focusResult(kind); value.focus.afPoint = afPoint;
    assert.deepEqual(focusObservations(value), []);
  }));

  const invalidBoxes = [undefined, null, [], [0.4, 0.2, 0.5], [0.4, 0.2, 0.5, 0.3, 0.9],
    ['0.4', 0.2, 0.5, 0.3], [NaN, 0.2, 0.5, 0.3], [0.4, 0.2, Infinity, 0.3],
    [0.5, 0.2, 0.4, 0.3], [0.4, 0.3, 0.5, 0.2], [0.4, 0.2, 0.4, 0.3], [0.4, 0.2, 0.5, 0.2],
    [-0.01, 0.2, 0.5, 0.3], [0.4, -0.01, 0.5, 0.3], [0.4, 0.2, 1.01, 0.3], [0.4, 0.2, 0.5, 1.01]];
  for (const field of ['frame', 'subject', 'face', 'eye']) invalidBoxes.forEach((box, index) =>
    test(`${kind} AF abstains with invalid ${field} box ${index}`, () => {
      const value = focusResult(kind);
      if (field === 'frame') value.focus.afFrame = box;
      if (field === 'subject') value.signals.persons[0].box = box;
      if (field === 'face') value.faces[0].box = box;
      if (field === 'eye') value.faces[0].eyeBoxes[0] = box;
      assert.deepEqual(focusObservations(value), []);
    }));

  for (const afPointOnEye of [true, false, null, undefined]) for (const afPointOnSubject of [true, false, null, undefined])
    test(`${kind} AF checks exact flags ${String(afPointOnEye)}/${String(afPointOnSubject)}`, () => {
      const value = focusResult(kind); Object.assign(value.focus, { afPointOnEye, afPointOnSubject });
      assert.deepEqual(focusObservations(value).map(item => item.id),
        afPointOnEye === (kind === 'eye') && afPointOnSubject === true ? [`focus-${kind}`] : []);
    });
  for (const field of ['afPointOnEye', 'afPointOnSubject']) for (const flag of [0, 1, 'true', 'false'])
    test(`${kind} AF rejects nonboolean ${field}=${flag}`, () => {
      const value = focusResult(kind); value.focus[field] = flag;
      assert.deepEqual(focusObservations(value), []);
    });

  const invalidSubjects = {
    'missing signals': value => { delete value.signals; },
    'missing persons': value => { delete value.signals.persons; },
    'no persons': value => { value.signals.persons = []; },
    'no main subject': value => { value.signals.persons[0].isMain = false; },
    'two main subjects': value => { value.signals.persons.push(main()); },
    'no faces': value => { value.faces = []; },
    'missing faces': value => { delete value.faces; },
    'two matching faces': value => { value.faces.push(face()); },
    'face outside subject': value => { value.signals.persons[0].box = [0.1, 0.4, 0.9, 0.9]; },
    'face half inside subject': value => {
      value.faces[0].box = [0.25, 0.125, 0.75, 0.375]; value.signals.persons[0].box = [0, 0, 0.5, 1];
    },
    'small face': value => { value.faces[0].box = [0.4, 0.18, 0.6, 0.219]; },
    'missing keypoints': value => { delete value.signals.persons[0].keypoints; },
    'missing points': value => { delete value.signals.persons[0].keypoints.points; },
    'mismatched nose': value => { value.signals.persons[0].keypoints.points[0] = point(0.9, 0.8); },
    'missing eyes': value => { delete value.faces[0].eyeBoxes; },
    'null eyes': value => { value.faces[0].eyeBoxes = null; },
    'zero eyes': value => { value.faces[0].eyeBoxes = []; },
    'one eye': value => { value.faces[0].eyeBoxes.pop(); },
    'three eyes': value => { value.faces[0].eyeBoxes.push([0.48, 0.23, 0.5, 0.25]); },
    'eye crossing face edge': value => { value.faces[0].eyeBoxes[1] = [0.59, 0.23, 0.61, 0.25]; },
    'eye outside face': value => { value.faces[0].eyeBoxes[1] = [0.7, 0.23, 0.72, 0.25]; },
  };
  for (const [name, change] of Object.entries(invalidSubjects)) test(`${kind} AF abstains with ${name}`, () => {
    const value = focusResult(kind); change(value);
    assert.deepEqual(focusObservations(value), []);
  });
  for (const index of [0, 1, 2]) for (const invalid of [undefined, point(0.5, 0.25, 0.649), point(NaN, 0.25), point(-0.01, 0.25)])
    test(`${kind} AF abstains with unreliable face keypoint ${index}/${String(invalid)}`, () => {
      const value = focusResult(kind); value.signals.persons[0].keypoints.points[index] = invalid;
      assert.deepEqual(focusObservations(value), []);
    });

  for (const pixels of [undefined, null, NaN, Infinity, -1, 63, '64'])
    test(`${kind} AF abstains with insufficient/unknown face exposure pixels ${String(pixels)}`, () => {
      const value = focusResult(kind); value.signals.persons[0].faceExposurePixels = pixels;
      assert.deepEqual(focusObservations(value), []);
    });
  for (const field of ['faceClippedHighlights', 'faceClippedShadows'])
    for (const clipped of [undefined, null, NaN, Infinity, -0.01, 0.5, 1, '0'])
      test(`${kind} AF abstains with invalid/saturated ${field}=${String(clipped)}`, () => {
        const value = focusResult(kind); value.signals.persons[0][field] = clipped;
        assert.deepEqual(focusObservations(value), []);
      });

  test(`${kind} AF accepts the exposure and keypoint confidence boundaries`, () => {
    const value = focusResult(kind), person = value.signals.persons[0];
    person.faceExposurePixels = 64; person.faceClippedHighlights = 0; person.faceClippedShadows = 0.499999;
    for (const index of [0, 1, 2]) person.keypoints.points[index][2] = 0.65;
    assert.deepEqual(focusObservations(value).map(item => item.id), [`focus-${kind}`]);
  });

  test(`${kind} AF ignores an unrelated background face when the subject match is unique`, () => {
    const value = focusResult(kind); value.faces.push(face({ box: [0.02, 0.18, 0.12, 0.36] }));
    value.signals.persons.push({ box: [0, 0.1, 0.15, 0.6] });
    assert.deepEqual(focusObservations(value).map(item => item.id), [`focus-${kind}`]);
  });

  test(`${kind} AF never treats aggregate background-face flags as a subject location`, () => {
    const value = focusResult(kind);
    value.faces.push(face({ box: [0.02, 0.18, 0.12, 0.36], eyeBoxes: [[0.04, 0.23, 0.06, 0.25], [0.08, 0.23, 0.1, 0.25]] }));
    value.signals.persons.push({ box: [0, 0.1, 0.15, 0.6] });
    value.focus.afPoint = kind === 'eye' ? [0.05, 0.24] : [0.07, 0.285];
    value.focus.afFrame = kind === 'eye' ? [0.04, 0.23, 0.06, 0.25] : [0.06, 0.27, 0.08, 0.3];
    assert.deepEqual(focusObservations(value), []);
  });

  test(`${kind} AF leaves ranking, scores, verdicts, groups and decisions unchanged`, () => {
    const value = focusResult(kind);
    Object.assign(value, { rank: 2, score: 0.8, scores: { quality: 0.7 }, decision: 'keep', groupId: 'group-a',
      groups: [{ unitIds: ['unit-a'] }], verdicts: [{ ruleId: 'G-PROXY-BLUR', verdict: 'pass' }] });
    const before = structuredClone(value);
    assert.deepEqual(focusObservations(freeze(value)).map(item => item.id), [`focus-${kind}`]);
    assert.deepEqual(value, before);
  });
}

test('eye AF accepts the face-height boundary but smaller subject faces stay silent', () => {
  const value = focusResult();
  value.signals.persons[0].box = [0.2, 0, 0.8, 0.9];
  setFacePoints(value.signals.persons[0], { nose: [0.5, 0.03], leftEye: [0.46, 0.015], rightEye: [0.54, 0.015] });
  value.faces[0] = face({ box: [0.4, 0, 0.6, 0.04], eyeBoxes: [[0.44, 0.01, 0.48, 0.02], [0.52, 0.01, 0.56, 0.02]] });
  Object.assign(value.focus, { afPoint: [0.46, 0.015], afFrame: [0.445, 0.012, 0.475, 0.018] });
  assert.deepEqual(focusObservations(value).map(item => item.id), ['focus-eye']);
  value.faces[0].box[3] = 0.039999;
  assert.deepEqual(focusObservations(value), []);
});

test('face-only AF location stays silent (not shipped: too few verified positives)', () => {
  assert.deepEqual(focusObservations(focusResult('face')), []);
});

for (const [side, eyeBox, afPoint] of [
  ['left', [0.41, 0.23, 0.43, 0.25], [0.42, 0.24]],
  ['right', [0.57, 0.23, 0.59, 0.25], [0.58, 0.24]],
  ['top', [0.45, 0.185, 0.47, 0.205], [0.46, 0.195]],
  ['bottom', [0.45, 0.335, 0.47, 0.355], [0.46, 0.345]],
]) test(`eye AF still accepts a matched eye outside the ${side} face inset`, () => {
  const value = focusResult(), [x, y] = afPoint;
  value.faces[0].eyeBoxes[0] = eyeBox; value.signals.persons[0].keypoints.points[1] = point(x, y);
  Object.assign(value.focus, { afPoint, afFrame: [x - 0.005, y - 0.005, x + 0.005, y + 0.005] });
  assert.deepEqual(focusObservations(value).map(item => item.id), ['focus-eye']);
});

test('off-subject AF stays silent regardless of aggregate flags', () => {
  const value = focusResult();
  Object.assign(value.focus, { afPoint: [0.825, 0.425], afFrame: [0.81, 0.41, 0.84, 0.44] });
  for (const afPointOnEye of [true, false, null]) for (const afPointOnSubject of [true, false, null]) {
    Object.assign(value.focus, { afPointOnEye, afPointOnSubject });
    assert.deepEqual(focusObservations(value), []);
  }
});

test('uncalibrated blur, crop, occlusion and exposure signals add no observations', () => {
  const value = focusResult(), person = value.signals.persons[0];
  value.focus = { status: 'na', faceSharpnessNative: 0, eyeSharpnessNative: 0, afPointOnSubject: false };
  Object.assign(person, { headroomHeads: 0, handsTruncated: [{ side: 'left', edge: 'left' }],
    faceClippedHighlights: 1, faceClippedShadows: 1, faceExposurePixels: 128,
    edgeAtJoint: [{ edge: 'top', joint: 'hairline', distanceHeads: -0.1, side: 'left' },
      { edge: 'bottom', joint: 'knee', distanceHeads: -0.1, side: 'left' }] });
  value.signals.objects = [{ label: 'object', box: [0.4, 0.18, 0.6, 0.36] }];
  value.metrics = { raw: { sharpness: 0, skyExposure: { subject: { meanLuma: 0 }, frame: { meanLuma: 200 } } } };
  value.verdicts = [{ ruleId: 'G-PROXY-BLUR', verdict: 'warn' }, { ruleId: 'P-CROP-KNEE', verdict: 'violate', personIndex: 0 }];
  assert.deepEqual(ruleObservations(value).map(item => item.id), ['face-front']);
});
