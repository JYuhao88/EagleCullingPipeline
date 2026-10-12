import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { scopeKey } from '../src/core/task-continuity.js';

const photo = id => ({ id, name: id, ext: 'jpg', width: 100, height: 100, btime: 1, mtime: 1 });

test('scope keys identify folders, the library and selections independent of order', () => {
  assert.equal(scopeKey({ type: 'library' }), 'library');
  assert.equal(scopeKey({ type: 'folder', folderId: 'F1' }, ['a']), 'folder:F1');
  assert.equal(scopeKey({ type: 'selection' }, ['b', 'a']), scopeKey({ type: 'selection' }, ['a', 'b', 'a']));
  assert.match(scopeKey({ type: 'folder' }, ['a']), /^selection:[0-9a-f]{16}$/);
  assert.equal(scopeKey({ type: 'selection' }, []), null);
});

test('re-analysing a scope carries human decisions, hides the old version, and supports match and rerun', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-continuity-'));
  const store = new RunStore(path.join(root, 'runs'));
  const pipeline = { async run(records) {
    return { results: records.map(record => ({ unitId: record.unitId, score: 0.5, flags: [] })),
      groups: [{ id: `group:${records.length}`, unitIds: records.map(record => record.unitId),
        suggested: Object.fromEntries(records.map(record => [record.unitId, 'candidate'])), ranking: [] }] };
  } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const send = async (pathname, body) => {
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const finished = async id => {
    for (let i = 0; i < 200; i++) {
      const run = await store.getRun(id);
      if (run?.status !== 'running') return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('run did not finish');
  };
  const scope = { type: 'folder', label: '旅行', folderId: 'F1' };

  const first = await send('/runs', { libraryPath: '/lib.library', scope, items: ['a', 'b'].map(photo) });
  assert.equal(first.status, 202);
  assert.equal((await finished(first.body.id)).scope.key, 'folder:F1');
  await new DecisionsStore(store.dir(first.body.id)).upsert([{ unitId: 'unit:a', action: 'selected', flags: [] }]);

  const second = await send('/runs', { libraryPath: '/lib.library', scope, items: ['a', 'b', 'c'].map(photo) });
  const run2 = await finished(second.body.id);
  assert.equal(run2.inherited.count, 1);
  const carried = await new DecisionsStore(store.dir(second.body.id)).read();
  assert.deepEqual(carried.map(row => [row.unitId, row.action, row.inheritedFrom]), [['unit:a', 'selected', first.body.id]]);
  assert.equal((await store.getRun(first.body.id)).supersededBy, second.body.id);

  const listed = await (await fetch(`${base}/runs?libraryPath=${encodeURIComponent('/lib.library')}`)).json();
  assert.deepEqual(listed.runs.map(run => run.id), [second.body.id]);
  assert.equal(listed.runs[0].reviewedUnitCount, 1);
  assert.equal(listed.runs[0].inheritedCount, 1);
  assert.equal(listed.runs[0].rerunnable, true);
  assert.equal(listed.runs[0].resumable, false);
  const everything = await (await fetch(`${base}/runs?includeSuperseded=1`)).json();
  assert.equal(everything.runs.length, 2);

  const match = await send('/runs/match', { libraryPath: '/lib.library', itemIds: ['a', 'b', 'c', 'd'], scope });
  assert.equal(match.body.key, 'folder:F1');
  assert.deepEqual({ runId: match.body.match.runId, matched: match.body.match.matched, missing: match.body.match.missing,
    sameScope: match.body.match.sameScope }, { runId: second.body.id, matched: 3, missing: 1, sameScope: true });
  const unrelated = await send('/runs/match', { libraryPath: '/lib.library', itemIds: ['z'] });
  assert.equal(unrelated.body.match, null);

  const rerun = await send('/runs', { rerunOf: second.body.id });
  assert.equal(rerun.status, 202);
  const run3 = await finished(rerun.body.id);
  assert.equal(run3.itemCount, 3);
  assert.equal(run3.inherited.count, 1);
  assert.equal((await store.getRun(second.body.id)).supersededBy, rerun.body.id);
  const missing = await send('/runs', { rerunOf: 'run-unknown' });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /重新选择/);
});
