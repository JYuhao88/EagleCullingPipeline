import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readdir, utimes, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { midKey, prefetchMid, readMid, midCovers, midRegion, trimMidCache } from '../src/core/native-mid.js';
import { withNativeImage } from '../src/core/native-image.js';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-mid-test-'));
  try {
    const file = path.join(dir, 'image.jpg');
    await sharp({ create: { width: 800, height: 400, channels: 3, background: 'green' } }).jpeg().toFile(file);
    await fn({ filePath: file, ext: 'jpg' }, { cacheDir: path.join(dir, 'mid'), edge: 400 }, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('mid key includes source stat, paired sources and parameters; invalidation is read-only',
  async () => fixture(async (record, options) => {
  const key = await midKey(record, options);
  assert.notEqual(await midKey(record, { ...options, edge: 300 }), key);
  assert.notEqual(await midKey(record, { ...options, quality: 98 }), key);
  assert.notEqual(await midKey(record, { ...options, pairedItems: [{ path: 'missing.raw' }] }), key);
  const result = await prefetchMid(record, options);
  assert.equal(result.available, true);
  assert.deepEqual([result.width, result.height], [400, 200]);
  assert.equal((await prefetchMid(record, options)).cached, true);
  const original = await stat(record.filePath);
  await utimes(record.filePath, new Date(), new Date(original.mtimeMs + 2000));
  assert.notEqual(await midKey(record, options), key);
  assert.equal(await readMid(record, options), null);
  assert.equal((await readdir(options.cacheDir)).some(name => name.endsWith('.tmp')), false);
}));
test('mid cache honors byte limit and touched LRU ordering', async () => fixture(async (record, options) => {
  const first = await prefetchMid(record, options);
  const secondOptions = { ...options, edge: 300 };
  const second = await prefetchMid(record, secondOptions);
  await utimes(first.path, new Date(1), new Date(1));
  await utimes(second.path, new Date(2), new Date(2));
  await readMid(record, options);
  await trimMidCache(options.cacheDir, first.bytes + (await stat(`${first.path}.json`)).size);
  assert.ok(await readMid(record, options));
  assert.equal(await readMid(record, secondOptions), null);
  await trimMidCache(options.cacheDir, 0);
  assert.deepEqual(await readdir(options.cacheDir), []);
}));
test('resolution selection rejects missing demand, oversampling and near 1:1; crops use display dimensions',
  async () => fixture(async (record, options) => {
  const mid = await prefetchMid(record, options), box = [0.25, 0.25, 0.75, 0.75];
  assert.equal(midCovers(mid, box, { width: 200, height: 100 }), true);
  for (const display of [null, { width: 201, height: 100 }, { width: 400, height: 200 }, { width: NaN, height: 10 }]) {
    assert.equal(midCovers(mid, box, display), false);
  }
  assert.equal(midCovers({ ...mid, width: 800, height: 400 }, box, { width: 360, height: 180 }), false);
  const crop = await midRegion(record, box, { width: 200, height: 100 }, options);
  const info = await sharp(crop.buffer).metadata();
  assert.deepEqual([info.width, info.height, crop.tier], [200, 100, 'mid']);
  assert.equal(await midRegion(record, box, { width: 400, height: 200 }, options), null);
}));
test('prefetch skips analysis and cancellation never publishes an incomplete cache', async () => fixture(async (record, options) => {
  assert.equal((await prefetchMid(record, { ...options, isBusy: () => true })).naReason, 'analysis-busy');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(prefetchMid(record, { ...options, signal: controller.signal }), /cancelled/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const foreground = withNativeImage(record, {}, async () => { entered(); await gate; return {}; });
  await started;
  const queuedController = new AbortController();
  const queued = prefetchMid(record, { ...options, signal: queuedController.signal });
  const rejected = assert.rejects(queued, /stale/);
  // Allow stat/cache miss to finish and reach the native queue.
  await new Promise(resolve => setTimeout(resolve, 30));
  queuedController.abort(new Error('stale'));
  release(); await foreground;
  await rejected;
  assert.equal(await readMid(record, options), null);
  let checks = 0;
  assert.equal((await prefetchMid(record, { ...options, isBusy: () => ++checks > 1 })).naReason, 'analysis-busy');
}));

test('region service uses cached resolution but preserves original dimensions near 1:1',
  async () => fixture(async (record, options, dir) => {
  const { regionCropImage, prefetchRegionImage } = await import('../src/server/focus-image.js');
  const state = { units: [{ id: 'u', primaryItemId: 'i', itemIds: ['i'] }], items: [{ ...record, id: 'i' }] };
  const box = [0.25, 0.25, 0.75, 0.75], display = { width: 200, height: 100 };
  const cold = await regionCropImage({ root: dir }, 'run', 'u', box, state, { ...options, display });
  assert.equal(cold.tier, 'original');
  await prefetchRegionImage('u', state, options);
  const hot = await regionCropImage({ root: dir }, 'run', 'u', box, state, { ...options, display });
  assert.equal(hot.tier, 'mid');
  const original = await regionCropImage({ root: dir }, 'run', 'u', box, state, { ...options, display: { width: 400, height: 200 } });
  assert.equal(original.tier, 'original');
  assert.equal(original.rect.width, 400);
  assert.equal((await regionCropImage({ root: dir }, 'run', 'u', box, state, options)).tier, 'original');
}));

test('foreground native request overtakes queued prefetch', async () => fixture(async (record, options) => {
  const order = [];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withNativeImage(record, {}, async () => { entered(); await gate; });
  await started;
  const background = withNativeImage(record, { background: true }, async () => { order.push('background'); });
  const foreground = withNativeImage(record, {}, async () => { order.push('foreground'); });
  release(); await Promise.all([first, background, foreground]);
  assert.deepEqual(order, ['foreground', 'background']);
}));

test('disabled and corrupt mid caches fall back without publishing partial files', async () => fixture(async (record, options) => {
  assert.equal((await prefetchMid(record, { ...options, maxBytes: 0 })).naReason, 'cache-disabled');
  assert.equal((await prefetchMid(record, { ...options, maxBytes: 1 })).naReason, 'cache-limit');
  assert.deepEqual(await readdir(options.cacheDir), []);
  const mid = await prefetchMid(record, options);
  assert.equal(await readMid(record, { ...options, maxBytes: 0 }), null);
  await writeFile(mid.path, 'invalid');
  assert.equal(await readMid(record, options), null);
  assert.equal(await midRegion(record, [0, 0, 0.5, 0.5], { width: 100, height: 50 }, options), null);
  assert.equal((await prefetchMid(record, options)).available, true);
}));

test('prefetch HTTP skips busy analysis and drops a disconnected request', async () => {
  const { EventEmitter } = await import('node:events');
  const { createRunsRouter } = await import('../src/server/runs-routes.js');
  const response = () => Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, status: null, body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.writableEnded = true; this.body = body && JSON.parse(body); },
  });
  const url = new URL('http://127.0.0.1/runs/test/native/u/prefetch');
  const busy = createRunsRouter({ active: { run: { status: 'running' } }, store: {
    unitData() { throw new Error('busy prefetch must not read run'); },
  } });
  const res = response();
  await busy({ method: 'POST' }, res, url);
  assert.equal(res.status, 200); assert.equal(res.body.naReason, 'analysis-busy');
  let release;
  const state = new Promise(resolve => { release = resolve; });
  const router = createRunsRouter({ store: { unitData: () => state } });
  const disconnected = response();
  const pending = router({ method: 'POST' }, disconnected, url);
  await Promise.resolve();
  disconnected.destroyed = true; disconnected.emit('close');
  release({ units: [{ id: 'u', primaryItemId: 'i', itemIds: ['i'] }], items: [{ id: 'i', path: 'missing.jpg' }] });
  await pending;
  assert.equal(disconnected.writableEnded, false);
  assert.equal(disconnected.listenerCount('close'), 0);
  const regionState = new Promise(resolve => { release = resolve; });
  const regions = createRunsRouter({ store: { unitData: () => regionState } });
  const closedRegion = response();
  const regionPending = regions({ method: 'GET' }, closedRegion,
    new URL('http://127.0.0.1/runs/test/native/u?box=0,0,0.5,0.5&width=100&height=100'));
  await Promise.resolve();
  closedRegion.destroyed = true; closedRegion.emit('close');
  release({ units: [{ id: 'u', primaryItemId: 'i', itemIds: ['i'] }], items: [{ id: 'i',
    get filePath() { throw new Error('disconnected region must not touch source'); },
  }] });
  await regionPending;
  assert.equal(closedRegion.writableEnded, false);
  assert.equal(closedRegion.listenerCount('close'), 0);
});
