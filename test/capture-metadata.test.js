import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCaptureMetadata, enrichCaptureMetadata } from '../src/core/capture-metadata.js';
import { listEagleImages } from '../src/core/metrics.js';
import { buildCaptureUnits } from '../src/core/capture-units.js';

test('EXIF preserves fractional precision and normalizes explicit offsets', () => {
  const result = parseCaptureMetadata({ DateTimeOriginal: '2024:01:02 00:00:01',
    SubSecTimeOriginal: '123456', OffsetTimeOriginal: '+08:00', Make: 'SONY', Model: 'ILCE-7M4', SerialNumber: '123' });
  assert.equal(result.captureTime, '2024-01-01T16:00:01.123Z');
  assert.equal(result.exif.subSecTimeOriginal, '123456');
  assert.equal(result.exif.offsetTimeOriginal, '+08:00');
  assert.equal(result.exif.localDate, '2024-01-02');
  assert.deepEqual(result.device, { make: 'SONY', model: 'ILCE-7M4', serial: '123' });
  assert.equal(parseCaptureMetadata({ SubSecDateTimeOriginal: '2024:01:01 12:00:00.9-0500' }).captureTime,
    '2024-01-01T17:00:00.900Z');
  const unknown = parseCaptureMetadata({ DateTimeOriginal: '2024:01:01 12:00:00' });
  assert.equal(unknown.exif.offsetTimeOriginal, null);
  assert.equal(unknown.captureTime, '2024-01-01T12:00:00.000Z');
  assert.equal(parseCaptureMetadata({ DateTimeOriginal: '2024:02:31 12:00:00' }).captureTime, null);
});

test('scan metadata batches remain serial and unavailable metadata keeps legacy pairing', async () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ id: String(i), filePath: `/tmp/${i}.jpg` }));
  let active = 0, peak = 0;
  const sizes = [];
  await enrichCaptureMetadata(records, { batchSize: 2, reader: async paths => {
    active++; peak = Math.max(peak, active); sizes.push(paths.length);
    await Promise.resolve(); active--;
    return paths.map(SourceFile => ({ SourceFile, DateTimeOriginal: '2024:01:01 12:00:00' }));
  } });
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(peak, 1);
  assert.equal(new Set(records.map(r => r.sessionId)).size, 1);
  const fallback = [{ id: 'j', name: 'A.jpg', ext: 'jpg', filePath: '/tmp/A.jpg' },
    { id: 'r', name: 'A.arw', ext: 'arw', filePath: '/tmp/A.arw' }];
  await enrichCaptureMetadata(fallback, { reader: async () => { throw new Error('missing tool'); } });
  assert.equal(buildCaptureUnits(fallback)[0].pairing, 'paired');
});

test('same stems pair inside capture sessions and device boundaries only', () => {
  const item = (id, ext, captureTime, serial = '1') => ({ id, ext, name: `DSC0001.${ext}`,
    captureTime, device: { model: 'Camera', serial } });
  const records = [item('a', 'jpg', '2024-01-01T12:00:00Z'), item('b', 'arw', '2024-01-01T12:00:00Z'),
    item('c', 'jpg', '2024-01-01T13:00:00Z'), item('d', 'arw', '2024-01-01T13:00:00Z'),
    item('e', 'jpg', '2024-01-01T12:00:00Z', '2'), item('f', 'arw', '2024-01-02T12:00:00Z')];
  const units = buildCaptureUnits(records);
  assert.equal(units.length, 4);
  assert.deepEqual(units.filter(u => u.pairing === 'paired').map(u => u.itemIds), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(units.flatMap(u => u.itemIds).sort(), records.map(r => r.id).sort());
});

test('multi-candidate unique pairing never drops remaining files', () => {
  const records = [
    { id: 'j1', name: 'A.jpg', ext: 'jpg', captureTime: '2024-01-01T12:00:00Z' },
    { id: 'j2', name: 'A.jpg', ext: 'jpg', captureTime: '2024-01-01T12:00:02Z' },
    { id: 'r', name: 'A.arw', ext: 'arw', captureTime: '2024-01-01T12:00:00Z' },
  ];
  const units = buildCaptureUnits(records);
  assert.equal(units.length, 2);
  assert.deepEqual(units[0].itemIds, ['j1', 'r']);
  assert.deepEqual(units[1].itemIds, ['j2']);
});

test('Eagle scan reads original stat and batched EXIF without altering original', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eagle-scan-metadata-'));
  try {
    const info = path.join(root, 'images', 'A.info');
    await mkdir(info, { recursive: true });
    await writeFile(path.join(info, 'metadata.json'), JSON.stringify({ id: 'A', name: 'DSC1', ext: 'jpg', size: 999 }));
    await writeFile(path.join(info, 'DSC1.jpg'), 'original');
    const records = await listEagleImages(root, { metadataReader: async paths => paths.map(SourceFile => ({
      SourceFile, DateTimeOriginal: '2024:01:01 12:00:00', Model: 'Camera', OffsetTimeOriginal: '+08:00',
    })) });
    assert.equal(records[0].fileStat.size, 8);
    assert.equal(records[0].size, 999);
    assert.equal(records[0].device.model, 'Camera');
    assert.equal(records[0].captureTime, '2024-01-01T04:00:00.000Z');
    assert.ok(records[0].sessionId);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('capture enrichment reports progress, normalizes source paths and keeps batch sessions together', async () => {
  const records = ['a', 'b'].map(id => ({ id, filePath: path.join(os.tmpdir(), `${id}.jpg`) }));
  const progress = [];
  await enrichCaptureMetadata(records, { batchSize: 1, onProgress: value => progress.push(value),
    reader: async files => files.map(file => ({ SourceFile: file.replaceAll('\\', '/'),
      DateTimeOriginal: '2026:01:01 12:00:00', Model: 'synthetic-device' })) });
  assert.deepEqual(progress.map(value => value.completed), [0, 1, 2]);
  assert.ok(progress.every(value => value.total === 2 && value.phase === 'capture-metadata'));
  assert.equal(records[0].captureTime, '2026-01-01T12:00:00.000Z');
  assert.equal(records[0].sessionId, records[1].sessionId);
});
