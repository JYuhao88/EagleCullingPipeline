import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ObservationRuntime } from '../src/core/observation-runtime.js';
import { writeSegmented } from '../src/core/segmented-results.js';
import { recoverRuntimePhotos } from '../scripts/observe-gaze-cache.mjs';

const idFor = value => `photo-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
const box = [.25, .2, .55, .7];
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gaze-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache-real', 'observations'), runsDir = path.join(root, 'runs');
  const outputDir = path.join(root, 'output'), itemsFile = path.join(root, 'cohort.jsonl');
  await mkdir(path.join(cacheDir, 'crops'), { recursive: true });
  await mkdir(runsDir);
  await symlink(path.dirname(cacheDir), path.join(root, 'cache-alias'), 'dir');
  const pixels = await sharp({ create: { width: 384, height: 384, channels: 3, background: '#123456' } }).png().toBuffer();
  const native = path.join(root, 'not-an-image'), preview = path.join(path.dirname(cacheDir), 'previews', 'preview.jpg');
  await mkdir(path.dirname(preview));
  await writeFile(native, 'stat-only source'); await writeFile(preview, 'stat-only preview');
  const f = { root, cacheDir, runsDir, outputDir, itemsFile, pixels, native, preview, photos: [] };
  f.options = { runsDir, outputDir, itemsFile, cacheDir: path.join(root, 'cache-alias', 'observations') };
  f.run = async (name, definitions) => {
    const data = { units: [], results: [], items: [], groups: [] };
    for (const definition of definitions) {
      const id = definition.unitId;
      const primary = { id: `${id}-primary`, name: 'private-filename.jpg', filePath: native, exif: {} };
      const paired = { id: `${id}-paired`, filePath: path.join(root, 'missing-pair') };
      const unit = { id, primaryItemId: primary.id, itemIds: [primary.id, paired.id] };
      const result = { unitId: id, fingerprint: definition.fingerprint || id, sourcePath: native,
        previewPath: preview, faces: [{ box }], ...definition.result };
      data.units.push(unit); data.results.push(result);
      data.items.push(...(definition.missingRecord ? [] : [primary, paired]));
      if (definition.crop !== false) {
        const runtime = new ObservationRuntime([], { cacheDir: await realpath(cacheDir) });
        await runtime.prepare(result, { ...primary, unitId: id, itemIds: unit.itemIds, pairedItems: [primary, paired] });
        const file = runtime.plans.get(id).cropFile;
        await writeFile(file, definition.bytes || pixels);
        definition.cacheFile = file;
      }
      if (!f.photos.some(row => row.id === idFor(id))) f.photos.push({ id: idFor(id), set: 'photos',
        faceHeight: .5, images: { face: 'images/teacher.jpg' } });
    }
    await writeSegmented(path.join(runsDir, name), data);
    await writeFile(itemsFile, jsonl(f.photos));
  };
  return f;
}

test('recovery reads segmented records and preserves canonical crop pixels without decoding sources or touching cache mtimes', async t => {
  const f = await fixture(t), definition = { unitId: 'one' };
  await f.run('segmented', [definition]);
  await mkdir(path.join(f.runsDir, 'unsegmented'));
  await writeFile(path.join(f.runsDir, 'unsegmented', 'results.json'), 'ignored');
  f.photos.push({ id: idFor('absent'), set: 'photos', faceHeight: .5, images: { face: 'images/absent.jpg' } },
    { id: idFor('tiny'), set: 'photos', faceHeight: .0499, images: { face: 'images/tiny.jpg' } },
    { id: 'celeba-fixture', set: 'celeba', faceHeight: .5, images: { face: 'images/celeba.jpg' } });
  await writeFile(f.itemsFile, jsonl(f.photos));
  const before = await stat(definition.cacheFile), files = await readdir(path.join(f.cacheDir, 'crops'));
  const result = await recoverRuntimePhotos(f.options);
  assert.deepEqual(result.counts, { requested: 2, recovered: 1, reasons: { 'missing-result': 1 }, abstained: 1 });
  const [row, missing] = result.rows;
  assert.equal(row.id, idFor('one'));
  assert.deepEqual(row.box, box);
  assert.equal(row.crop, `images/runtime-photos/${idFor('one')}.png`);
  assert.equal(row.file, row.crop);
  assert.equal(row.cachedCropSha256, createHash('sha256').update(f.pixels).digest('hex'));
  assert.equal(row.decodedRgbSha256, createHash('sha256').update(await sharp(f.pixels).raw().toBuffer()).digest('hex'));
  assert.equal(missing.reason, 'missing-result');
  const cleaned = await readFile(path.join(f.outputDir, row.crop));
  assert.deepEqual(await sharp(cleaned).raw().toBuffer(), await sharp(f.pixels).raw().toBuffer());
  assert.equal(cleaned.includes(Buffer.from('pHYs')), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.outputDir, 'runtime-photos.json'), 'utf8')), result);
  assert.equal((await stat(definition.cacheFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(path.join(f.cacheDir, 'crops')), files);
  assert.equal(JSON.stringify(result.rows).includes(f.root), false);
  for (const key of ['sourcePath', 'unitId', 'fingerprint', 'name', 'runId', 'pairedItems'])
    assert.equal(JSON.stringify(result.rows).includes(`"${key}"`), false);
});

test('ambiguous or changed subjects, small faces, missing records and absent caches abstain without borrowing teacher crops', async t => {
  const f = await fixture(t);
  const faces = [{ box: [.1, .1, .2, .7] }, { box: [.4, .2, .9, .5] }];
  await f.run('subjects', [
    { unitId: 'changed', result: { faces } },
    { unitId: 'ambiguous', result: { faces, signals: { persons: [{ isMain: true, box: [0, 0, 1, 1] }] } } },
    { unitId: 'none', result: { faces: [] } },
    { unitId: 'small', result: { faces: [{ box: [.1, 0, .2, .0499] }] } },
    { unitId: 'record', missingRecord: true },
    { unitId: 'uncached', crop: false }
  ]);
  const result = await recoverRuntimePhotos(f.options);
  assert.equal(result.counts.recovered, 0);
  assert.deepEqual(result.rows.map(row => row.reason),
    ['subject-mismatch', 'ambiguous-subject', 'no-face', 'small-face', 'missing-record', 'missing-crop']);
  assert.equal(result.rows[0].subjectMismatch, true);
  assert.equal(result.rows[1].subjectMismatch, true);
  assert.equal(result.rows[3].minFaceHeightEligible, false);
  assert.deepEqual(await readdir(path.join(f.outputDir, 'images/runtime-photos')), []);
});

test('cached PNGs reject profiles, text, wrong dimensions and appended bytes while preserving clean PNGs', async t => {
  const f = await fixture(t);
  const profile = await sharp(f.pixels).withMetadata().png().toBuffer();
  const wrongSize = await sharp(f.pixels).resize(383, 384).png().toBuffer();
  const text = Buffer.alloc(16);
  text.writeUInt32BE(4); text.write('tEXt', 4); text.write('note', 8);
  const textPng = Buffer.concat([f.pixels.subarray(0, 33), text, f.pixels.subarray(33)]);
  await f.run('metadata', [
    { unitId: 'clean' }, { unitId: 'profile', bytes: profile }, { unitId: 'text', bytes: textPng },
    { unitId: 'size', bytes: wrongSize }, { unitId: 'tail', bytes: Buffer.concat([f.pixels, Buffer.from('comment')]) }
  ]);
  const result = await recoverRuntimePhotos(f.options);
  assert.equal(result.counts.recovered, 1);
  assert.equal(result.counts.reasons['invalid-crop'], 4);
});

test('duplicate runs dedupe identical crops but abstain when distinct current crops share a teacher id', async t => {
  const f = await fixture(t);
  await f.run('a', [{ unitId: 'same' }, { unitId: 'conflict', fingerprint: 'first' }]);
  const otherPixels = await sharp({ create: { width: 384, height: 384, channels: 3, background: '#654321' } }).png().toBuffer();
  await f.run('b', [{ unitId: 'same' }, { unitId: 'conflict', fingerprint: 'second', bytes: otherPixels }]);
  const result = await recoverRuntimePhotos(f.options);
  assert.equal(result.counts.recovered, 1);
  assert.equal(result.rows[1].reason, 'multiple-runtime-crops');
  assert.equal(result.rows[1].crop, undefined);
});
