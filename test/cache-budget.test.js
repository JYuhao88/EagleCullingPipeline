import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, utimes, access, symlink } from 'node:fs/promises';
import { cacheUsage, enforceCacheBudget, readCacheLimit, writeCacheLimit, createCacheMaintenance, DEFAULT_MAX_BYTES, GB }
  from '../src/core/cache-budget.js';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';

const DAY = 86400000, NOW = Date.parse('2026-10-12T12:00:00Z');
const exists = file => access(file).then(() => true, () => false);
async function put(root, relative, bytes, ageDays) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
  const time = new Date(NOW - ageDays * DAY);
  await utimes(file, time, time);
  return file;
}
// Windows scanners briefly hold new files; retry so cleanup never masks a test or leaves servers open.
const removeTree = root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
async function fixture(t, { cleanup = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-budget-'));
  if (cleanup) t.after(() => removeTree(root));
  return root;
}

test('usage counts every cache category and skips symlinks', async t => {
  const root = await fixture(t);
  await put(root, 'previews/a.jpg', 100, 3);
  await put(root, 'previews/a.jpg.json', 10, 3);
  await put(root, 'results-v2/ab/x.json', 40, 3);
  await put(root, 'capture-metadata/metadata.json', 7, 3);
  const outside = await put(root, '../outside-' + path.basename(root), 1000, 3);
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, 'previews/link.jpg'));
  const usage = await cacheUsage(root);
  assert.equal(usage.totalBytes, 157);
  assert.deepEqual(usage.categories.find(row => row.name === 'previews'), { name: 'previews', label: '预览', bytes: 110, files: 2 });
});

test('budget evicts derived previews in pairs before results, oldest first, down to 90 percent', async t => {
  const root = await fixture(t);
  const oldPreview = await put(root, 'previews/old.jpg', 300, 10);
  const oldSidecar = await put(root, 'previews/old.jpg.json', 20, 2);
  const newerPreview = await put(root, 'previews/newer.jpg', 300, 5);
  const result = await put(root, 'results-v2/ab/r.json', 300, 30);
  const embedding = await put(root, 'embeddings/e.json', 100, 40);
  const recent = await put(root, 'previews/recent.jpg', 300, 0.5);
  const report = await enforceCacheBudget({ cacheRoot: root, maxBytes: 1000, now: NOW });
  // 1320 bytes -> target 900. A pair ages by its newest member, so `newer` (5 days) goes before the `old` pair (2 days).
  assert.equal(await exists(oldPreview), false);
  assert.equal(await exists(oldSidecar), false);
  assert.equal(await exists(newerPreview), false);
  assert.equal(await exists(embedding), true);
  assert.equal(await exists(result), true);
  assert.equal(await exists(recent), true, 'files used in the last 24 hours are kept');
  assert.equal(report.totalBytes, 700);
});

test('budget falls through to embeddings then results and honours protection', async t => {
  const root = await fixture(t);
  const preview = await put(root, 'previews/p.jpg', 100, 10);
  const embedding = await put(root, 'embeddings/e.json', 400, 9);
  const kept = await put(root, 'results-v2/ab/keep.json', 400, 60);
  const result = await put(root, 'results-v2/cd/r.json', 400, 8);
  await enforceCacheBudget({ cacheRoot: root, maxBytes: 700, now: NOW, protect: { files: [kept] } });
  assert.equal(await exists(preview), false);
  assert.equal(await exists(embedding), false);
  assert.equal(await exists(kept), true);
  assert.equal(await exists(result), false);
});

test('budget is a no-op under the limit and never evicts counted-only indexes', async t => {
  const root = await fixture(t);
  const metadata = await put(root, 'capture-metadata/metadata.json', 5000, 90);
  const journal = await put(root, 'results.jsonl', 5000, 90);
  const preview = await put(root, 'previews/p.jpg', 100, 10);
  assert.deepEqual((await enforceCacheBudget({ cacheRoot: root, maxBytes: 20000, now: NOW })).deleted, []);
  await enforceCacheBudget({ cacheRoot: root, maxBytes: 1000, now: NOW });
  assert.equal(await exists(preview), false);
  assert.equal(await exists(metadata), true);
  assert.equal(await exists(journal), true);
});

test('derived clear removes only previews and intermediate images, all keeps counted-only indexes', async t => {
  const root = await fixture(t);
  const preview = await put(root, 'previews/p.jpg', 10, 0);
  const mid = await put(root, 'native-mid/m.jpg', 10, 0);
  const result = await put(root, 'results-v2/ab/r.json', 10, 0);
  const metadata = await put(root, 'capture-metadata/metadata.json', 10, 0);
  await enforceCacheBudget({ cacheRoot: root, maxBytes: 0, scope: 'derived', now: NOW });
  assert.deepEqual([await exists(preview), await exists(mid), await exists(result)], [false, false, true]);
  await enforceCacheBudget({ cacheRoot: root, maxBytes: 0, scope: 'all', now: NOW });
  assert.deepEqual([await exists(result), await exists(metadata)], [false, true]);
});

test('limit settings default to 5 GB and reject out-of-range values', async t => {
  const root = await fixture(t);
  assert.equal(await readCacheLimit(root), DEFAULT_MAX_BYTES);
  await writeCacheLimit(root, 10 * GB);
  assert.equal(await readCacheLimit(root), 10 * GB);
  await writeFile(path.join(root, 'cache-settings.json'), JSON.stringify({ maxBytes: 1 }));
  assert.equal(await readCacheLimit(root), DEFAULT_MAX_BYTES);
});

test('maintenance is skipped while busy and throttled afterwards', async t => {
  const root = await fixture(t);
  await writeCacheLimit(root, GB);
  let busy = true, clock = NOW;
  const maintenance = createCacheMaintenance({ cacheRoot: root, isBusy: () => busy, now: () => clock });
  assert.equal(await maintenance.trigger(), undefined);
  busy = false;
  assert.ok(await maintenance.trigger());
  clock += 1000;
  assert.equal(await maintenance.trigger(), undefined, 'second run within ten minutes is throttled');
  await maintenance.dispose();
});

test('cache routes validate input, refuse clearing during analysis, and stub pipelines get no cache routes', async t => {
  const root = await fixture(t, { cleanup: false });
  const runs = path.join(root, 'runs'), cacheRoot = path.join(root, 'cache');
  await put(cacheRoot, 'previews/p.jpg', 10, 5);
  let finish;
  const pipeline = { cacheRoot, async run() { await new Promise(resolve => { finish = resolve; }); return { results: [], groups: [] }; } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: new RunStore(runs) });
  await service.listen();
  let stub;
  t.after(async () => { finish?.(); await service.close(); await stub?.close(); await removeTree(root); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const usage = await (await fetch(base + '/cache/usage')).json();
  assert.equal(usage.totalBytes, 10); assert.equal(usage.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal((await post('/cache/limit', { maxBytes: 10 })).status, 400);
  assert.equal((await post('/cache/limit', { maxBytes: 2 * GB })).status, 200);
  assert.equal((await (await fetch(base + '/cache/usage')).json()).maxBytes, 2 * GB);
  assert.equal((await post('/cache/clear', { scope: 'everything' })).status, 400);
  assert.equal((await post('/runs', { items: [] })).status, 202);
  assert.equal((await post('/cache/clear', { scope: 'all' })).status, 409);
  for (let i = 0; i < 200 && !finish; i++) await new Promise(r => setTimeout(r, 10));
  finish();
  for (let i = 0; i < 100 && (await (await fetch(base + '/runs/status')).json()).active; i++) await new Promise(r => setTimeout(r, 10));
  const cleared = await (await post('/cache/clear', { scope: 'derived' })).json();
  assert.equal(cleared.totalBytes, 0);
  stub = createAnalysisServer({ port: 0, pipeline: {}, runStore: new RunStore(runs) });
  await stub.listen();
  assert.equal((await fetch(`http://127.0.0.1:${stub.server.address().port}/cache/usage`)).status, 404);
});
