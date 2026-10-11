import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/server/run-store.js';
import { createRunsRouter, reviewGroups } from '../src/server/runs-routes.js';

test('progress writes preserve result file and snapshot queued metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-scale-'));
  try {
    const store = new RunStore(root);
    const run = { id: 'scale', status: 'running', progress: { completed: 0 } };
    await store.save(run, { units: [{ id: 'u' }], items: [{ id: 'i' }], duplicateCandidates: { u: ['v'] } });
    const file = path.join(root, 'scale', 'results.json');
    const before = await stat(file);
    const expected = await readFile(file, 'utf8');
    const pending = store.saveProgress(run);
    run.status = 'completed';
    await pending;
    assert.equal((await store.getRun('scale')).status, 'running');
    for (let n = 1; n <= 50; n++) await store.saveProgress({ ...run, progress: { completed: n } });
    assert.equal(await readFile(file, 'utf8'), expected);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    assert.deepEqual((await store.get('scale')).duplicateCandidates, { u: ['v'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rapid progress persists metadata at stages and completion, never results per unit', async () => {
  let metadata = 0;
  let payloads = 0;
  let completed;
  const finished = new Promise(resolve => completed = resolve);
  const store = {
    async save(run, data) { payloads++; if (run.status === 'completed') completed(data); },
    async saveProgress() { metadata++; },
  };
  const pipeline = { async run(records, { onProgress }) {
    for (let n = 0; n < 5000; n++) onProgress({ stage: 'metrics', completed: n, total: 5000 });
    onProgress({ stage: 'grouping', completed: 5000, total: 5000 });
    return { results: [], groups: [], duplicateCandidates: { a: ['b'] } };
  } };
  const route = createRunsRouter({ pipeline, store, progressIntervalMs: 60_000 });
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{"items":[]}'); } };
  const res = { writeHead() {}, end() {} };
  await route(req, res, new URL('http://localhost/runs'));
  const data = await finished;
  assert.equal(payloads, 1);
  assert.equal(metadata, 3);
  assert.deepEqual(data.duplicateCandidates, { a: ['b'] });
});

test('review confidence lookup accepts indexed results with legacy id', () => {
  const state = { groups: [{ unitIds: ['a', 'b'], ranking: [
    { unitId: 'a', rank: 1, score: .9, reasons: [] }, { unitId: 'b', rank: 2, score: .5, reasons: [] },
  ] }], results: [{ id: 'a', flags: ['blurry'] }] };
  assert.equal(reviewGroups(state)[0].confidence, 'low');
});


test('active status stays lightweight while terminal payload is being persisted', async () => {
  const active = { run: { id: 'run-scale', status: 'completed', groups: [{ id: 'g' }],
    results: [{ unitId: 'u' }], controller: {} } };
  const route = createRunsRouter({ pipeline: {}, store: {}, active });
  let payload;
  const res = { writeHead() {}, end(body) { payload = JSON.parse(body); } };
  await route({ method: 'GET' }, res, new URL('http://localhost/runs/run-scale'));
  assert.deepEqual(payload, { id: 'run-scale', status: 'completed' });
});
