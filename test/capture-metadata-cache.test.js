import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CaptureMetadataCache, captureMetadataKey, normalizeCapturePath } from '../src/core/capture-metadata-cache.js';
import { enrichCaptureMetadata, parseCaptureMetadata } from '../src/core/capture-metadata.js';
import { listEagleImages } from '../src/core/metrics.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capture-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'cache');
  const records = [];
  for (const id of ['a', 'b', 'c']) {
    const info = path.join(root, 'images', `${id}.info`);
    await mkdir(info, { recursive: true });
    await writeFile(path.join(info, 'metadata.json'), JSON.stringify({ id, ext: 'jpg', name: id }));
    const filePath = path.join(info, `${id}.jpg`);
    await writeFile(filePath, 'synthetic');
    records.push({ id, filePath });
  }
  const calls = [];
  const reader = async files => {
    calls.push(files);
    return files.map(SourceFile => ({ SourceFile,
      DateTimeOriginal: SourceFile.includes('c.info') ? '2024:01:01 13:00:00' : '2024:01:01 12:00:00',
      SubSecTimeOriginal: '123456', Model: 'Synthetic', SerialNumber: '1', OffsetTimeOriginal: '+08:00' }));
  };
  return { root, directory, records, reader, calls, cache: options => new CaptureMetadataCache({ directory, ...options }) };
}

test('cold/warm/disabled library records and sessions match field for field; hits checkpoint and progress', async t => {
  const f = await fixture(t);
  const scan = metadataCache => listEagleImages(f.root, { metadataReader: f.reader, metadataCache });
  const uncached = await scan(false);
  const cold = await scan(f.cache());
  assert.deepEqual(cold, uncached);
  const callsBefore = f.calls.length, progress = [], saved = [];
  const hot = await listEagleImages(f.root, { metadataReader: f.reader, metadataCache: f.cache(),
    checkpoint: { get: async () => null, put: async (key, value) => saved.push([key, structuredClone(value)]) },
    onProgress: value => progress.push(value) });
  assert.deepEqual(hot, uncached);
  assert.equal(f.calls.length, callsBefore);
  assert.equal(saved.length, 3);
  assert.deepEqual(progress.map(p => [p.completed, p.total, p.cached]), [[0, 3, 0], [1, 3, 1], [2, 3, 2], [3, 3, 3]]);
  // Returned records cannot mutate the persisted parsed output.
  hot[0].device.model = 'changed';
  assert.deepEqual(await scan(f.cache()), uncached);
});

test('size and mtime changes invalidate only affected files; partial hits advance progress', async t => {
  const f = await fixture(t);
  const run = onProgress => enrichCaptureMetadata(structuredClone(f.records),
    { reader: f.reader, metadataCache: f.cache(), onProgress });
  await run();
  await writeFile(f.records[0].filePath, 'different size');
  const originalReader = f.reader;
  f.reader = async files => (await originalReader(files)).map(row => ({ ...row, Model: 'Updated' }));
  const progress = [];
  const refreshed = await run(p => progress.push(p));
  assert.equal(refreshed[0].device.model, 'Updated');
  assert.equal(refreshed[1].device.model, 'Synthetic');
  assert.deepEqual(f.calls.at(-1), [f.records[0].filePath]);
  assert.deepEqual(progress.map(p => [p.completed, p.cached]), [[0, 0], [1, 1], [2, 2], [3, 2]]);
  await utimes(f.records[1].filePath, new Date('2025-01-01'), new Date('2025-01-01'));
  await run();
  assert.deepEqual(f.calls.at(-1), [f.records[1].filePath]);
});

test('parser version, broken JSON, modified valid JSON and oversize cache are safely rebuilt', async t => {
  const f = await fixture(t);
  const run = options => enrichCaptureMetadata(structuredClone(f.records), { reader: f.reader, metadataCache: f.cache(options) });
  await run();
  await run({ version: 'next' });
  assert.equal(f.calls.length, 2);
  await run(); // restore current version so the modified payload exercises checksum validation
  const file = path.join(f.directory, 'metadata.json');
  for (const content of ['{broken', '{"version":"capture-v1","entries":[]}',
    (await readFile(file, 'utf8')).replace('Synthetic', 'Modified')]) {
    await writeFile(file, content);
    const before = f.calls.length;
    await run();
    assert.equal(f.calls.length, before + 1);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 'capture-v1');
    assert.deepEqual(await readdir(f.directory), ['metadata.json']);
  }
  await run({ maxBytes: 500 });
  assert.ok((await readFile(file)).length <= 500);
});

test('Windows drive, UNC, separators and case normalize; POSIX case remains distinct', () => {
  const info = { size: 10, mtimeMs: 12.5 };
  assert.equal(captureMetadataKey('C:\\Photos\\Sub\\..\\A.JPG', info, 'win32'),
    captureMetadataKey('c:/photos/a.jpg', info, 'win32'));
  assert.equal(normalizeCapturePath('\\\\SERVER\\Share\\A.JPG', 'win32'),
    normalizeCapturePath('//server/share/a.jpg', 'win32'));
  assert.notEqual(captureMetadataKey('/photos/A.jpg', info, 'linux'), captureMetadataKey('/photos/a.jpg', info, 'linux'));
  assert.notEqual(captureMetadataKey('/photos/A.jpg', info, 'linux'),
    captureMetadataKey('/photos/A.jpg', { ...info, size: 11 }, 'linux'));
});

test('bounded eviction, failed tool, missing rows, mid-read changes and unwritable cache preserve scan output', async t => {
  const f = await fixture(t);
  const value = parseCaptureMetadata({});
  const cache = f.cache({ maxEntries: 2 });
  for (let i = 0; i < 3; i++) cache.put(captureMetadataKey(`/synthetic/${i}`, { size: 1, mtimeMs: 1 }), value);
  await cache.flush();
  assert.equal((await f.cache().load()).entries.size, 2);
  const run = reader => enrichCaptureMetadata(structuredClone(f.records), { reader, metadataCache: f.cache() });
  await run(async () => { throw new Error('unavailable'); });
  await run(async () => []);
  await run(async files => files.map(SourceFile => ({ SourceFile, Error: 'unreadable' })));
  assert.equal((await f.cache().load()).entries.size, 2);
  await run(async files => {
    await writeFile(files[0], 'changed during read');
    return f.reader(files);
  });
  assert.equal((await f.cache().load()).entries.size, 4); // two old entries, two stable files
  const blocked = path.join(f.root, 'blocked');
  await writeFile(blocked, 'file instead of directory');
  const result = await enrichCaptureMetadata(structuredClone(f.records), {
    reader: f.reader, metadataCache: new CaptureMetadataCache({ directory: blocked }) });
  const reference = await enrichCaptureMetadata(structuredClone(f.records), { reader: f.reader, metadataCache: false });
  assert.deepEqual(result, reference);
});

test('cancellation flushes completed batches; run checkpoint resume still skips EXIF', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let batches = 0;
  await assert.rejects(enrichCaptureMetadata(structuredClone(f.records), {
    metadataCache: f.cache(), batchSize: 1, signal: controller.signal,
    reader: async files => {
      if (++batches === 2) controller.abort(new Error('cancelled'));
      return f.reader(files);
    },
  }), /cancelled/);
  const before = f.calls.length;
  await enrichCaptureMetadata(structuredClone(f.records), { metadataCache: f.cache(), reader: f.reader });
  assert.equal(f.calls.length, before + 1);
  assert.deepEqual(f.calls.at(-1), f.records.slice(1).map(r => r.filePath));
  const saved = new Map();
  const checkpoint = { get: async key => saved.get(key), put: async (key, value) => saved.set(key, structuredClone(value)) };
  const cold = await listEagleImages(f.root, { metadataReader: f.reader, metadataCache: f.cache(), checkpoint });
  const resumed = await listEagleImages(f.root, { checkpoint, metadataCache: false,
    metadataReader: async () => { assert.fail('restored scan must not read EXIF'); } });
  assert.deepEqual(resumed, cold);
});


test('successful files without EXIF cache explicit null fields instead of retrying the tool', async t => {
  const f = await fixture(t);
  let calls = 0;
  const reader = async files => { calls++; return files.map(SourceFile => ({ SourceFile })); };
  const run = metadataCache => enrichCaptureMetadata(structuredClone(f.records), { reader, metadataCache });
  const cold = await run(f.cache());
  const hot = await run(f.cache());
  assert.equal(calls, 1);
  assert.deepEqual(hot, cold);
  assert.deepEqual(hot, await run(false));
  assert.equal(hot[0].captureTime, null);
  assert.equal(hot[0].device, null);
});
