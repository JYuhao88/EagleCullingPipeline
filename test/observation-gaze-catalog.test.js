import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { observationsFromVector, validObservationHead } from '../src/core/observation-head.js';

const bytes = await readFile(new URL('../src/core/observation-heads/gaze-iris-q2-clip-v1.json', import.meta.url));
const head = JSON.parse(bytes);
const fixture = JSON.parse(await readFile(new URL('./fixtures/observation-gaze-runtime.json', import.meta.url), 'utf8'));

test('production gaze head preserves the accepted coefficients, calibration and both pinned models', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'f3350621868b444d573179bd887fa1bffd1917f17bcee198a15b4efa4092eacc');
  assert.equal(validObservationHead(head), true);
  assert.equal(head.version, 'gaze-iris-q2-clip-v1');
  assert.deepEqual(head.encoder, { id: 'mediapipe-iris-pose-q2-clip-b32-q', dimensions: 740,
    modelSha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    clipModelSha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' });
  assert.deepEqual(head.input, { type: 'face-crop', expansion: 1.8, size: 384, minFaceHeight: .05 });
  assert.equal(head.attributes.length, 1);
  const attribute = head.attributes[0];
  assert.equal(attribute.id, 'gaze');
  assert.equal(attribute.type, 'logistic');
  assert.equal(attribute.showThreshold, .91);
  assert.equal(attribute.temperature, 1.076452351253655);
  assert.deepEqual(attribute.positive, { text: '看镜头', tone: 'neutral' });
  assert.equal(Object.hasOwn(attribute, 'negative'), false);
  assert.equal(Object.hasOwn(attribute, 'quantization'), false);
  for (const vector of [attribute.weights, attribute.normalization.mean, attribute.normalization.scale]) {
    assert.equal(Array.isArray(vector) && vector.length === 740 && vector.every(Number.isFinite), true);
    assert.equal(vector.some(value => value !== Math.fround(value)), true);
  }
  assert.equal(attribute.normalization.scale.every(value => value > 0), true);
});

test('production gaze inference reproduces accepted public Node vectors beside the display threshold', () => {
  assert.equal(fixture.sourceJob, 'w33-gaze-ffd7236efe3e');
  assert.equal(fixture.rows.length, 2);
  assert.deepEqual(fixture.rows.map(row => row.items.length).sort(), [0, 1]);
  for (const row of fixture.rows) {
    assert.match(row.id, /^openimages-[a-f0-9]{16}$/);
    assert.deepEqual(Object.keys(row).sort(), ['box', 'features', 'id', 'items']);
    assert.equal(row.features.length, 740);
    assert.equal(row.features.every(Number.isFinite), true);
    const actual = observationsFromVector(row.features, head, { box: row.box });
    const withoutConfidence = items => items.map(({ confidence, ...item }) => item);
    assert.deepEqual(withoutConfidence(actual), withoutConfidence(row.items), row.id);
    for (let index = 0; index < actual.length; index++)
      assert.ok(Math.abs(actual[index].confidence - row.items[index].confidence) <= 1e-10, row.id);
    assert.deepEqual(observationsFromVector(row.features, head, { box: [0, 0, .1, .0499] }), []);
  }
});
