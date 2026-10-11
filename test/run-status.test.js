import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';

test('busy response and reopen use run metadata without starting a second analysis', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-status-'));
  const store = new RunStore(root);
  let finish, calls = 0;
  const pipeline = { async run(records, { onProgress }) {
    calls++; onProgress({ stage: 'metrics', completed: 3, total: 100, cached: 0 });
    await new Promise(resolve => { finish = resolve; });
    return { results: [], groups: [], units: [] };
  } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store });
  await service.listen();
  t.after(async () => { finish?.(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = () => fetch(base + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [] }) });
  const first = await (await post()).json();
  for (let i = 0; i < 100; i++) {
    const progress = await (await fetch(base + '/runs/' + first.id)).json();
    if (progress.progress.completed === 3) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const busy = await post(), body = await busy.json();
  assert.equal(busy.status, 409); assert.equal(body.run.id, first.id);
  assert.equal(body.run.progress.completed, 3); assert.equal(body.run.progress.total, 100);
  const status = await (await fetch(base + '/runs/status')).json();
  assert.equal(status.active.id, first.id); assert.equal(calls, 1);
  assert.equal((await (await fetch(base + '/runs/' + first.id)).json()).status, 'running');
  finish();
  for (let i = 0; i < 100 && (await store.getRun(first.id)).status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await store.getRun(first.id)).status, 'completed');
});

test('reopen lists failed and interrupted runs using metadata only', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-status-'));
  const store = new RunStore(root);
  await store.saveProgress({ id: 'run-failed', status: 'failed', startedAt: '2026-01-02', error: 'EPERM rename' });
  await store.saveProgress({ id: 'run-interrupted', status: 'running', startedAt: '2026-01-01' });
  store.results = () => { throw new Error('Full results must not be loaded for status'); };
  const service = createAnalysisServer({ port: 0, pipeline: {}, runStore: store });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const status = await (await fetch(`http://127.0.0.1:${service.server.address().port}/runs/status`)).json();
  assert.equal(status.active, null);
  assert.deepEqual(status.recent.map(run => run.status), ['failed', 'interrupted']);
  const reopened = await (await fetch(`http://127.0.0.1:${service.server.address().port}/runs/run-interrupted`)).json();
  assert.equal(reopened.status, 'interrupted');
  assert.equal((await store.getRun('run-interrupted')).status, 'running');
});

test('analysis is accepted before a slow scan finishes and its scan progress is recoverable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-scan-'));
  const store = new RunStore(root);
  let release, scanned = 0, selected;
  const service = createAnalysisServer({ port: 0, runStore: store,
    pipeline: { async run() { return { results: [], groups: [] }; } },
    scanItems: async (library, { onProgress, itemIds }) => {
      selected = itemIds; scanned++; onProgress({ stage: 'scanning', completed: 64, total: 8000, cached: 0 });
      await new Promise(resolve => { release = resolve; }); return [];
    } });
  await service.listen();
  t.after(async () => { release?.(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const response = await fetch(base + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryPath: 'synthetic.library', itemIds: ['synthetic-item'] }) });
  assert.equal(response.status, 202);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const status = await (await fetch(base + '/runs/status')).json();
  assert.equal(scanned, 1); assert.deepEqual(selected, ['synthetic-item']);
  assert.equal(status.active.progress.stage, 'scanning');
  assert.equal(status.active.progress.completed, 64); assert.equal(status.active.progress.total, 8000);
  const runId = status.active.id; release();
  for (let i = 0; i < 100 && (await store.getRun(runId)).status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await store.getRun(runId)).status, 'completed');
});
