import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { seededRandom, utility } from '../scripts/simulate-culling.mjs';
import { RunStore } from '../src/server/run-store.js';
import { handleReviewRoute } from '../src/server/review-routes.js';
import { PROTECTED_LEARNING_LIBRARY } from '../src/core/learning-data.js';

test('simulated hidden preferences switch direction and penalize closed eyes', () => {
  const darkTight = { metrics: { raw: { meanLuma: 70 }, cropTightness: 0.8 } };
  const brightLoose = { metrics: { raw: { meanLuma: 180 }, cropTightness: 0.2 } };
  assert.ok(utility(darkTight, 'dark-tight') > utility(brightLoose, 'dark-tight'));
  assert.ok(utility(brightLoose, 'bright-loose') > utility(darkTight, 'bright-loose'));
  assert.ok(utility({ ...darkTight, metrics: { ...darkTight.metrics, eyesClosed: 1 } }, 'dark-tight') < utility(darkTight, 'dark-tight'));
  const first = seededRandom(808), second = seededRandom(808);
  assert.deepEqual(Array.from({ length: 20 }, first), Array.from({ length: 20 }, second));
});

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

test('image unit index coalesces reads, isolates callers and invalidates after atomic replacement', async t => {
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
  assert.equal(reads, 1);
  assert.equal(rows[0].results.length, 1); assert.equal(rows[0].items[0].id, 'ia');
  rows[0].results[0].embedding[0] = 9;
  assert.equal((await store.unitData(run.id, 'a')).results[0].embedding[0], 0.1);
  fixture.results[0].previewPath = '/tmp/updated.jpg';
  await store.save(run, fixture);
  assert.equal((await store.unitData(run.id, 'a')).results[0].previewPath, '/tmp/updated.jpg');
  assert.equal(reads, 2);
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

test('constructed workflow batch keeps content-disjoint heldouts and passes unchanged learning gates', async t => {
  const { strongFixture } = await import('../scripts/simulate-culling-strong.mjs');
  const { evaluatePreferenceHead } = await import('../src/core/preference-head.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'w8-strong-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const photo = path.join(root, 'source.jpg'); await writeFile(photo, 'unit-test-proxy');
  const data = await strongFixture(root, { run: {}, results: [{ previewPath: photo }] },
    { trainingGroups: 120, stableGroups: 0, switchedGroups: 0, holdoutGroups: 2 });
  assert.equal(new Set(data.results.map(r => r.contentHash)).size, data.results.length);
  assert.ok(data.groups.every(g => g.ranking[0].unitId.endsWith('-neutral')));
  const byId = new Map(data.results.map(r => [r.unitId, r]));
  const groups = data.groups.slice(0, 120).map((g, i) => ({ id: g.id, time: i + 1, signal: 'corrected',
    winners: [byId.get(g.unitIds.find(id => id.endsWith('-dark'))).contentHash],
    candidates: g.ranking.map(r => ({ hash: byId.get(r.unitId).contentHash, baselineScore: r.score, baselineRank: r.rank,
      feature: byId.get(r.unitId) })) }));
  const report = evaluatePreferenceHead(groups);
  assert.equal(report.ready, true); assert.ok(report.splits.every(s => s.purgedGroups === 0 && s.improvement.lower > 0));
  assert.ok(data.groups.at(-1).ranking.filter(r => /-(closed|blurred)$/.test(r.unitId))
    .every(r => r.reasons.includes('硬伤门槛：排在通过者之后')));
});

test('QA evidence reader preserves partial UTF-8 lines and concurrent snapshots without reparsing history', async t => {
  const { createEventReader } = await import('../scripts/simulation-event-reader.mjs');
  const { appendFile, rename } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'w8-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'), reader = createEventReader(file);
  const line = Buffer.from(JSON.stringify({ id: 'a', reason: '并列' }) + '\n');
  const cut = line.indexOf(Buffer.from('并')) + 1;
  await writeFile(file, line.subarray(0, cut));
  assert.deepEqual(await reader(), []);
  await appendFile(file, line.subarray(cut));
  const first = await reader(); assert.equal(first[0].reason, '并列');
  await appendFile(file, JSON.stringify({ id: 'b' }) + '\n');
  assert.deepEqual((await Promise.all([reader(), reader()])).map(rows => rows.length), [2, 2]);
  assert.equal(first.length, 1);
  const next = path.join(root, 'replacement'); await writeFile(next, JSON.stringify({ id: 'c' }) + '\n');
  await rename(next, file); assert.equal((await reader())[0].id, 'c');
  await appendFile(file, 'invalid JSON\n'); await assert.rejects(reader, SyntaxError);
});
