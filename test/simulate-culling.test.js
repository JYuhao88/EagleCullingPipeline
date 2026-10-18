import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { RunStore } from '../src/server/run-store.js';
import { handleReviewRoute } from '../src/server/review-routes.js';
import { PROTECTED_LEARNING_LIBRARY } from '../src/core/learning-data.js';

test('injected service clock timestamps exposure and decisions without wall-time duration leakage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w8-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(path.join(root, 'runs'));
  const photo = path.join(root, 'proxy.jpg'); await writeFile(photo, 'clock-test-feature-source');
  const run = { id: 'clock-run', status: 'completed', libraryPath: PROTECTED_LEARNING_LIBRARY };
  await store.save(run, { units: [{ id: 'a', primaryItemId: 'a', itemIds: ['a'] }],
    items: [{ id: 'a', path: photo }], results: [{ unitId: 'a', metrics: { sharpness: 0.7 } }],
    groups: [{ id: 'g', unitIds: ['a'], ranking: [{ unitId: 'a', rank: 1, score: 0.7 }], suggested: { a: 'selected' } }] });
  let stamp = Date.UTC(2026, 0, 1), response;
  const ctx = { runStore: store, clock: () => new Date(stamp), readBody: async req => req.body,
    json: (_res, status, body) => { response = { status, body }; } };
  const call = async (suffix, body) => {
    assert.equal(await handleReviewRoute({ method: 'POST', url: `/runs/${run.id}/${suffix}`, body }, {}, ctx), true);
    assert.equal(response.status, 200); assert.equal(response.body.learningWarning, undefined);
  };
  await call('learning/exposure', { groupId: 'g', order: ['a'], viewport: ['a'], aiVisible: true });
  stamp += 1000;
  await call('decisions', { decisions: [{ unitId: 'a', action: 'selected' }] });
  const rows = (await readFile(path.join(root, 'learning/events/v1/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(rows[1].timestamp, '2026-01-01T00:00:01.000Z');
  assert.equal(rows[1].decisions[0].updatedAt, rows[1].timestamp);
  assert.equal(rows[1].durationMs, 1000);
  // Without the injected clock, retain caller-provided historical Decision times.
  delete ctx.clock;
  await call('decisions', { decisions: [{ unitId: 'a', action: 'candidate', updatedAt: '2025-01-01T00:00:00.000Z' }] });
  assert.equal((await store.learningData.events.read()).at(-1).decisions[0].updatedAt, '2025-01-01T00:00:00.000Z');
  stamp = Date.UTC(2026, 0, 2);
  ctx.clock = () => new Date(stamp);
  ctx.api = { assertLibrary: async () => ({ path: PROTECTED_LEARNING_LIBRARY }), async *items() {} };
  await call('learning/scan-deletions', {});
  assert.equal(response.body.tombstones, 1);
  assert.equal((await store.learningData.events.read()).at(-1).timestamp, '2026-01-02T00:00:00.000Z');
});

test('image offset index avoids full reads, isolates callers and invalidates after atomic replacement', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w8-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root), run = { id: 'images', status: 'completed' };
  const fixture = { units: [{ id: 'a', primaryItemId: 'ia', itemIds: ['ia'] },
    { id: 'b', primaryItemId: 'ib', itemIds: ['ib'] }],
  items: [{ id: 'ia', path: '/tmp/a.jpg' }, { id: 'ib', path: '/tmp/b.jpg' }],
  results: [{ unitId: 'a', previewPath: '/tmp/a.jpg', embedding: [0.1] },
    { unitId: 'b', previewPath: '/tmp/b.jpg', embedding: [0.2] }],
  groups: [{ id: 'g', unitIds: ['a', 'b'], ranking: [], suggested: {} }] };
  await store.save(run, fixture);
  let reads = 0;
  const read = store.results.bind(store);
  store.results = async id => { reads++; return read(id); };
  const rows = await Promise.all(Array.from({ length: 10 }, () => store.unitData(run.id, 'a')));
  assert.equal(reads, 0);
  assert.equal(rows[0].results.length, 1); assert.equal(rows[0].items[0].id, 'ia');
  rows[0].results[0].embedding[0] = 9;
  assert.equal((await store.unitData(run.id, 'a')).results[0].embedding[0], 0.1);
  fixture.results[0].previewPath = '/tmp/updated.jpg';
  await store.save(run, fixture);
  assert.equal((await store.unitData(run.id, 'a')).results[0].previewPath, '/tmp/updated.jpg');
  assert.equal(reads, 0);
  assert.equal((await store.unitData(run.id, 'missing')).results.length, 0);
  await store.mutateGroups(run.id, 'split', { groupId: 'g', unitIds: ['a'] });
  const indexed = await store.unitData(run.id, 'a');
  assert.equal(indexed.groups.length, 1);
  assert.notEqual(indexed.groups[0].id, 'g');
  assert.deepEqual(indexed.groups[0].unitIds, ['a']);
});

test('run snapshots isolate mutable callers and invalidate cached analysis across store instances', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w8-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root), other = new RunStore(root);
  const run = { id: 'snapshot', status: 'completed' };
  const data = { results: [{ unitId: 'a', metrics: { sharpness: 0.7 } }], groups: [], units: [], items: [] };
  await store.save(run, data);
  const one = await store.get(run.id);
  one.results[0].metrics.sharpness = 0;
  assert.equal((await store.get(run.id)).results[0].metrics.sharpness, 0.7);
  const original = (await store.get(run.id, { readOnly: true })).results;
  assert.equal((await store.get(run.id, { readOnly: true })).results, original);
  data.results[0].metrics.sharpness = 0.9;
  await other.save(run, data);
  assert.equal((await store.get(run.id, { readOnly: true })).results[0].metrics.sharpness, 0.9);
});
