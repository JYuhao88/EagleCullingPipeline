import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/server/run-store.js';
import { createRunsRouter } from '../src/server/runs-routes.js';
import { DecisionsStore } from '../src/core/decisions-store.js';

async function request(store, query = '') {
  let status, payload;
  const res = { writeHead(code) { status = code; }, end(body) { payload = JSON.parse(body); } };
  await createRunsRouter({ store })({ method: 'GET' }, res, new URL(`http://localhost/runs${query}`));
  return { status, payload };
}

test('GET /runs pages lightweight summaries without reading malformed full results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runs-list-'));
  try {
    const store = new RunStore(root);
    for (let n = 1; n <= 3; n++) {
      await store.saveProgress({ id: `run-${n}`, status: n === 2 ? 'failed' : 'completed',
        startedAt: `2026-01-0${n}T00:00:00Z`, itemCount: 3, unitCount: 3, groupCount: 2,
        scope: { type: 'folder', label: '示例文件夹' }, error: n === 2 ? '服务中断' : null,
        libraryPath: '/private/example-library', results: ['must omit'] });
      await store.saveReviewSummary(`run-${n}`, [{ id: 'g1', unitIds: ['a', 'b'] }, { id: 'g2', unitIds: ['c'] }]);
      await writeFile(path.join(root, `run-${n}`, 'results.json'), 'not JSON');
      await new DecisionsStore(store.dir(`run-${n}`)).write([
        { unitId: 'a', source: 'human' }, { unitId: 'b', source: 'human' }, { unitId: 'c', source: 'suggested' },
      ]);
    }
    store.get = store.results = async () => { throw new Error('full results read forbidden'); };
    const first = await request(store, '?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload.runs.map(run => run.id), ['run-3', 'run-2']);
    assert.deepEqual(first.payload.page, { total: 3, cursor: 0, limit: 2, nextCursor: '2' });
    assert.equal(first.payload.runs[0].reviewedGroupCount, 1);
    assert.equal(first.payload.runs[1].error, '服务中断');
    assert.equal(first.payload.runs[0].scope.label, '示例文件夹');
    assert.equal(JSON.stringify(first.payload).includes('libraryPath'), false);
    assert.equal(JSON.stringify(first.payload).includes('must omit'), false);
    const second = await request(store, '?limit=2&cursor=2');
    assert.deepEqual(second.payload.runs.map(run => run.id), ['run-1']);
    assert.equal(second.payload.page.nextCursor, null);
    assert.equal((await request(store, '?cursor=99')).payload.runs.length, 0);
    assert.equal((await request(store, '?libraryPath=%2Fprivate%2Fexample-library')).payload.page.total, 3);
    assert.deepEqual((await request(store, '?libraryPath=%2Fother.library')).payload.runs, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GET /runs supports empty roots and unknown legacy progress, validates paging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runs-list-'));
  try {
    assert.deepEqual((await request(new RunStore(path.join(root, 'missing')))).payload.runs, []);
    const store = new RunStore(root);
    await store.saveProgress({ id: 'old', status: 'cancelled', groupCount: 4, progress: { stage: 'metrics', completed: 2 } });
    await mkdir(path.join(root, 'broken'));
    await writeFile(path.join(root, 'broken', 'run.json'), '{');
    const { payload } = await request(store);
    assert.equal(payload.runs.length, 1);
    assert.equal(payload.runs[0].groupCount, 4);
    assert.equal(payload.runs[0].reviewedGroupCount, null);
    assert.equal(payload.runs[0].scope.type, 'unknown');
    assert.equal(payload.runs[0].progress.completed, 2);
    for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=-1', '?cursor=NaN']) {
      assert.equal((await request(store, query)).status, 400);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review summaries follow corrections without loading result shards during listing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runs-list-'));
  try {
    const store = new RunStore(root);
    const run = { id: 'corrected', status: 'completed', groupCount: 2 };
    await store.save(run, { groups: [{ id: 'g1', unitIds: ['a'] }, { id: 'g2', unitIds: ['b'] }],
      units: [], items: [], results: [{ unitId: 'a', flags: [] }, { unitId: 'b', flags: [] }] });
    await store.mutateGroups(run.id, 'merge', { groupIds: ['g1', 'g2'] });
    await new DecisionsStore(store.dir(run.id)).write([{ unitId: 'a', source: 'human' }, { unitId: 'b', source: 'human' }]);
    store.get = store.results = async () => { throw new Error('full results read forbidden'); };
    await rm(path.join(store.dir(run.id), (await store.manifest(run.id)).generation), { recursive: true });
    const summary = (await request(store)).payload.runs[0];
    assert.equal(summary.groupCount, 1);
    assert.equal(summary.reviewedGroupCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
