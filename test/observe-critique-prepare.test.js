import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { headsVersion, selectCorpus, specialistFacts, validateDerivative } from '../scripts/observe-critique-prepare.mjs';

test('critique corpus selects all photos and deterministic public subset without training faces or groups', () => {
  const rows = [{ id: 'p', set: 'photos' }, { id: 'c', set: 'celeba' }, { id: 'g', set: 'group', kind: 'group' },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, set: 'openimages' }))];
  const selected = selectCorpus(rows, 3);
  assert.equal(selected.length, 4);
  assert.equal(selected[0].id, 'p');
  assert.deepEqual(selected, selectCorpus([...rows].reverse(), 3));
  assert.throws(() => selectCorpus(rows, 20), /incomplete/);
  assert.throws(() => selectCorpus(rows, 201), /limit/);
  assert.throws(() => selectCorpus([...rows, rows[0]], 0), /duplicate/);
});

test('specialist facts only admit positive persisted shipped heads above their existing thresholds', () => {
  const heads = [{ attributes: [{ id: 'smile', showThreshold: 0.83 }, { id: 'mouth', showThreshold: 0.73 }] },
    { attributes: [{ id: 'gaze', showThreshold: 0.91 }] }];
  const row = { observations: { version: headsVersion(heads), items: [
    { id: 'smile', text: '在笑', source: 'model', confidence: 0.83 },
    { id: 'mouth', text: '嘴张开', source: 'model', confidence: 0.72 },
    { id: 'gaze', text: '看镜头', source: 'model', confidence: 0.95 },
    { id: 'unknown', text: '自然放松', source: 'model', confidence: 1 },
    { id: 'smile', text: '没有笑', source: 'model', confidence: 1 },
    { id: 'mouth', text: '嘴张开', source: 'teacher', confidence: 1 },
  ] } };
  const before = JSON.stringify(row);
  assert.deepEqual(specialistFacts(row, heads).map(fact => fact.id), ['smile', 'gaze']);
  assert.equal(JSON.stringify(row), before);
  assert.deepEqual(specialistFacts({ observations: { ...row.observations, version: 'stale-heads' } }, heads), []);
});

test('reference validation rejects metadata and >768px without modifying source', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'critique-prepare-'));
  try {
    const clean = path.join(dir, 'clean.jpg'), large = path.join(dir, 'large.jpg'), metadata = path.join(dir, 'meta.jpg');
    const image = sharp({ create: { width: 12, height: 12, channels: 3, background: '#ccc' } });
    await writeFile(clean, await image.clone().jpeg().toBuffer());
    await writeFile(metadata, await image.clone().withMetadata().jpeg().toBuffer());
    await writeFile(large, await image.clone().resize(769, 12).jpeg().toBuffer());
    const stat = await validateDerivative(clean);
    assert.equal(stat.width, 12);
    assert.match(stat.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(validateDerivative(metadata), /unsafe|metadata/);
    await assert.rejects(validateDerivative(large), /unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
