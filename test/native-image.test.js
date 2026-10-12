import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { nativeCrop, normalizedRect, withNativeImage } from '../src/core/native-image.js';
import { withPerformanceMode } from '../src/core/performance-mode.js';
import { choosePreview } from '../src/core/previews.js';

test('native crop uses upright original pixels and cache remains bounded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-test-'));
  try {
    const file = path.join(dir, 'image.jpg');
    await sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(file);
    const record = { filePath: file, ext: 'jpg' };
    const options = { cacheDir: path.join(dir, 'crops'), maxEntries: 1 };
    const crop = await nativeCrop(record, [0, 0, 0.5, 0.5], options);
    assert.equal(crop.available, true);
    assert.deepEqual([crop.source.width, crop.source.height], [80, 120]);
    const meta = await sharp(crop.path).metadata();
    assert.deepEqual([meta.width, meta.height], [40, 60]);
    assert.equal((await nativeCrop(record, [0, 0, 0.5, 0.5], options)).cached, true);
    await nativeCrop(record, [0.5, 0.5, 1, 1], options);
    assert.equal((await readdir(options.cacheDir)).filter(f => f.endsWith('.jpg')).length, 1);
    assert.equal((await nativeCrop(record, [0, 0, 2, 1], options)).naReason, 'invalid-crop');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing raw decoders degrade explicitly, paired image remains native', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-test-'));
  try {
    const file = path.join(dir, 'paired.jpg');
    await sharp({ create: { width: 128, height: 64, channels: 3, background: 'blue' } }).jpeg().toFile(file);
    const record = { filePath: path.join(dir, 'missing.arw'), ext: 'arw' };
    const missing = await withNativeImage(record, { python: 'no-such-python' }, () => assert.fail('unavailable source'));
    assert.equal(missing.available, false);
    assert.ok(missing.warnings.some(w => w.includes('rawpy')));
    const paired = await nativeCrop(record, [0, 0, 1, 1], {
      pairedItems: [{ filePath: file, ext: 'jpg' }], cacheDir: path.join(dir, 'cache') });
    assert.equal(paired.source.kind, 'jpeg');
    assert.equal(paired.source.width, 128);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('normalized coordinate mapping and proxy source mapping survive cache reuse', async () => {
  assert.deepEqual(normalizedRect([0.1, 0.2, 0.4, 0.6], 100, 50), { left: 10, top: 10, width: 30, height: 20 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-test-'));
  try {
    const file = path.join(dir, 'image.jpg');
    const data = Buffer.alloc(100 * 80 * 3);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await sharp(data, { raw: { width: 100, height: 80, channels: 3 } }).withMetadata({ orientation: 8 }).jpeg().toFile(file);
    const record = { filePath: file, ext: 'jpg' };
    const options = { cacheDir: path.join(dir, 'previews') };
    await choosePreview(record, options);
    assert.deepEqual([record.sourceMapping.width, record.sourceMapping.height], [80, 100]);
    const cached = { ...record, sourceMapping: undefined };
    await choosePreview(cached, options);
    assert.deepEqual(cached.sourceMapping, record.sourceMapping);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all EXIF orientations match sharp auto-orientation including mirrored images', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-orient-'));
  try {
    const pixels = Buffer.alloc(96 * 64 * 3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 3;
      pixels[i] = x * 2; pixels[i + 1] = y * 3; pixels[i + 2] = (x + y) % 200;
    }
    for (let orientation = 1; orientation <= 8; orientation++) {
      const file = path.join(dir, `${orientation}.jpg`);
      await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } }).withMetadata({ orientation }).jpeg({ quality: 98 }).toFile(file);
      const expected = await sharp(file).rotate().removeAlpha().raw().toBuffer();
      const result = await withNativeImage({ filePath: file, ext: 'jpg' }, {}, async ({ image }) => image().removeAlpha().raw().toBuffer());
      assert.deepEqual(result, expected, `orientation ${orientation}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('turbo pixel budget serializes 100 MP originals and cancelled queues release reservations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-budget-'));
  try {
    const file = path.join(dir, 'image.jpg');
    await sharp({create:{width:8,height:8,channels:3,background:'red'}}).jpeg().toFile(file);
    await withPerformanceMode('turbo', async () => {
      let active = 0, peak = 0;
      const record = {filePath:file,ext:'jpg',width:10000,height:10000};
      const tasks = Array.from({length:4}, () => withNativeImage(record, {}, async () => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
      }));
      await Promise.all(tasks);assert.equal(peak,1);
      const controller = new AbortController();
      const first = withNativeImage(record, {}, async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      const queued = withNativeImage(record, {signal:controller.signal}, () => assert.fail('cancelled queue ran'));
      const rejected = assert.rejects(queued,/cancelled/);
      controller.abort(new Error('cancelled'));
      await Promise.all([first,rejected]);
      assert.equal(await withNativeImage(record, {}, () => 'reused'), 'reused');
    });
  } finally {await rm(dir,{recursive:true,force:true});}
});
