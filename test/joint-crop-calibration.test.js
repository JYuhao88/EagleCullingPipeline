import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { computeSignals } from '../src/core/signals.js';
import { detectPose, POSE_SIGNALS_CACHE_KEY } from '../src/core/pose.js';
import { evaluateRules } from '../src/core/rules-engine.js';
import { jointPrediction, compareTeacher } from '../ml/teacher/measure_qa.mjs';
import { summarizeCrops } from '../ml/teacher/joint_crop_evaluate.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/w2-measure-joints.json', import.meta.url), 'utf8'));
test('pixel crop regression: localized knee, bent-leg ankle, truncated-face neck and edge wrist', () => {
  for (const row of fixture.rows) {
    const raw = structuredClone(row.pose), saved = structuredClone(raw);
    const person = computeSignals(raw).persons.find((p) => p.isMain);
    assert.equal(jointPrediction(person, row.joint), row.expected, row.id);
    assert.deepEqual(raw, saved, 'validity guards must preserve original model coordinates/scores');
    if (row.joint === 'neck') {
      assert.equal(person.headScaleSource, 'shoulder-estimate');
      assert.equal(person.headroomHeads, undefined);
      assert.equal(jointPrediction(person, 'hairline'), 'na');
    }
  }
});

test('one hidden opposite side cannot create a measured-safe joint; uncertain excluded per joint only', () => {
  const labels = [{ unitId: 'one', name: 'sample', joints: Object.fromEntries(
    ['wrist', 'elbow', 'knee', 'ankle', 'neck', 'hairline'].map((joint) =>
      [joint, { status: ['knee', 'ankle'].includes(joint) ? 'uncertain' : 'safe' }])) }];
  const result = { unitId: 'one', signals: { persons: [{ isMain: true, edgeAtJoint: [],
    jointObservability: { wrist: true, elbow: true, neck: true, hairline: true, knee: false, ankle: false } }] } };
  const report = compareTeacher(labels, [result]);
  assert.equal(report.overall.teacherDefinite, 4);
  assert.equal(report.overall.teacherUncertain, 2);
  assert.equal(report.overall.correct, 4);
  assert.equal(report.overall.agreement, 1);
  result.signals.persons[0].jointObservability.wrist = false;
  const unknown = compareTeacher(labels, [result]);
  assert.equal(unknown.overall.correct, 3);
  assert.equal(unknown.overall.naOnDefinite, 1);
  assert.equal(unknown.overall.confirmedAgreementOverDefinite, .75);
});

test('synthetic NA never counts as safe or as a confirmed correct prediction', () => {
  const summary = summarizeCrops([{ expected: 'safe', predicted: 'na' }, { expected: 'crop', predicted: 'crop' }]);
  assert.equal(summary.agreement, 1);
  assert.equal(summary.confirmedOverAll, .5);
  assert.equal(summary.negativeNA, 1);
});

test('pose stage enriches real proxies with image and matched face measurements without another model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'measure-pose-'));
  try {
    const file = path.join(dir, 'white.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toFile(file);
    const fake = { run: async (items) => items.map(({ id }) => ({ id, available: true,
      source: { width: 64, height: 64, proxyWidth: 64, proxyHeight: 64, kind: 'jpeg' },
      persons: [{ isMain: true, box: [.1, .1, .9, .9], score: .9,
        keypoints: { format: 'coco-wholebody-133', points: Array.from({ length: 133 }, () => [.5, .5, 0]) } }] })) };
    const [pose] = await detectPose([{ id: 'one', filePath: file, faces: [{ box: [.3, .2, .7, .5] }] }], { pool: fake });
    const signals = computeSignals(pose), verdicts = evaluateRules(signals);
    assert.equal(signals.imageMeasurements.clippedHighlights, 1);
    assert.equal(signals.persons[0].faceClippedHighlights, 1);
    assert.equal(verdicts.find((v) => v.ruleId === 'P-EXPOSURE-INTENT').verdict, 'violate');
    assert.match(POSE_SIGNALS_CACHE_KEY, /^signals-v3/);
    const [missing] = await detectPose([{ id: 'missing', filePath: path.join(dir, 'absent') }], { pool: fake });
    assert.ok(missing.measurementError);
    assert.equal(computeSignals(missing).imageMeasurements.clippedHighlights, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
