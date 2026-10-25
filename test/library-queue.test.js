import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { LibraryCatalog } from '../src/core/library-catalog.js';

async function fakeLibrary(root) {
  const library = path.join(root, 'photos.library');
  await mkdir(path.join(library, 'images'), { recursive: true });
  await writeFile(path.join(library, 'metadata.json'), JSON.stringify({ folders: [
    { id: 'F1', name: '汕头', children: [{ id: 'F2', name: 'good', children: [] }] }, { id: 'F3', name: '空的', children: [] }] }));
  const items = { a: ['F1', 'jpg'], b: ['F1', 'arw'], c: ['F2', 'jpg'], d: [null, 'jpg'], e: ['F1', 'jpg', true], f: ['F1', 'mp4'] };
  for (const [id, [folder, ext, isDeleted]] of Object.entries(items)) {
    await mkdir(path.join(library, 'images', `${id}.info`));
    await writeFile(path.join(library, 'images', `${id}.info`, 'metadata.json'),
      JSON.stringify({ id, ext, folders: folder ? [folder] : [], isDeleted: Boolean(isDeleted) }));
  }
  return library;
}

test('the library view counts analyzed photos per folder and a folder queue runs one analysis at a time', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'library-queue-'));
  const library = await fakeLibrary(root);
  const store = new RunStore(path.join(root, 'runs'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const pipeline = { async run(records) {
    const ids = records.map(record => record.unitId);
    started.push(records.map(record => record.id).sort());
    if (started.length === 1) await gate;
    return { results: ids.map(unitId => ({ unitId, score: 0.5, flags: [] })),
      groups: [{ id: 'g1', unitIds: ids, suggested: Object.fromEntries(ids.map(id => [id, 'candidate'])),
        ranking: ids.map((unitId, i) => ({ unitId, rank: i + 1, score: 1 - i / 10, reasons: [] })) }] };
  } };
  const scanItems = async (_library, { itemIds }) => itemIds.map(id => ({ id, name: id, ext: 'jpg', width: 10, height: 10 }));
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store, scanItems });
  await service.listen();
  t.after(async () => {
    release(); await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const lib = `libraryPath=${encodeURIComponent(library)}`;
  const call = async (pathname, method = 'GET', body) => {
    const response = await fetch(base + pathname, { method, ...(body ? { headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryPath: library, ...body }) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  // The queue empties a moment before the next run becomes active, so wait for the expected number of runs too.
  const idle = async (runs = 0) => {
    for (let i = 0; i < 500; i++) {
      const health = (await call('/health')).body;
      if (started.length >= runs && !health.activeRunId && !(await call(`/queue?${lib}`)).body.queue.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`queue did not finish: ${JSON.stringify([(await call('/health')).body.activeRunId,
      (await call(`/queue?${lib}`)).body, started, (await call(`/runs?limit=5&${lib}`)).body.runs.map(run => [run.status, run.error])])}`);
  };

  const first = (await call(`/library/overview?${lib}`)).body;
  assert.equal(first.total, 4, 'deleted photos and videos are not counted');
  assert.equal(first.analyzed, 0);
  assert.deepEqual([first.folders[0].count, first.folders[0].children[0].count, first.unfiled.count], [2, 1, 1]);
  assert.deepEqual(first.folders[0].subtree, { count: 3, analyzed: 0 });
  const where = (await call('/library/selection', 'POST', { itemIds: ['c'] })).body;
  assert.deepEqual(where.scopes.map(scope => [scope.type, scope.folderId, scope.label, scope.count]), [['folder', 'F2', '汕头 › good', 1]]);
  assert.equal(started.length, 0, 'looking at a selection never starts anything');

  const queued = (await call('/queue', 'POST', { scopes: [{ type: 'folder', folderId: 'F1' }] })).body;
  assert.equal(queued.started.scope.label, '汕头');
  const more = (await call('/queue', 'POST', { scopes: [{ type: 'folder', folderId: 'F2' }, { type: 'unfiled' }] })).body;
  assert.equal(more.added, 2);
  assert.deepEqual(more.queue.map(row => [row.label, row.position]), [['汕头 › good', 1], ['未归入文件夹', 2]]);
  assert.equal((await call('/queue', 'POST', { scopes: [{ type: 'folder', folderId: 'F2' }] })).body.added, 0, 'no duplicates');
  assert.equal(JSON.parse(await readFile(path.join(store.root, 'analysis-queue.json'), 'utf8')).entries.length, 2,
    'the queue survives a restart');
  assert.equal((await call(`/items/c/analysis?${lib}`)).body.queued.position, 1);
  assert.equal((await call(`/items/a/analysis?${lib}`)).body.queued.analyzing, true);
  const during = (await call(`/library/overview?${lib}`)).body;
  assert.equal(during.folders[0].running, 0); assert.equal(during.folders[0].children[0].queued, 1);

  const unfiled = more.queue[1].id, good = more.queue[0].id;
  assert.deepEqual((await call(`/queue/${unfiled}/top?${lib}`, 'POST', {})).body.queue.map(row => row.label), ['未归入文件夹', '汕头 › good']);
  assert.deepEqual((await call(`/queue/${good}?${lib}`, 'DELETE')).body.queue.map(row => row.label), ['未归入文件夹']);

  release(); await idle(2);
  assert.deepEqual(started, [['a', 'b'], ['d']], 'a folder covers only its own photos; the next entry starts by itself');
  const after = (await call(`/library/overview?${lib}`)).body;
  assert.equal(after.analyzed, 3);
  assert.deepEqual([after.folders[0].analyzed, after.folders[0].children[0].analyzed, after.unfiled.analyzed], [2, 0, 1]);
  assert.deepEqual((await call(`/library/unanalyzed?${lib}&folderId=F2`)).body.itemIds, ['c']);
  const runs = (await call(`/runs?limit=5&${lib}`)).body.runs;
  assert.ok(runs.some(run => run.scope?.type === 'unfiled' && run.scope.label === '未归入文件夹'));

  const all = (await call('/queue', 'POST', { allUnanalyzed: true })).body;
  assert.equal(all.started.scope.label, '汕头 › good', 'only places with unanalyzed photos are queued');
  await idle(3);
  assert.equal((await call(`/library/overview?${lib}`)).body.analyzed, 4);
  assert.equal((await call('/library/overview?libraryPath=/tmp/x')).status, 400);
  assert.equal((await call('/queue', 'POST', { scopes: [{ type: 'folder', folderId: 'gone' }] })).status, 400);
});

test('the catalog serves its last read while a fresh one loads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'library-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = await fakeLibrary(root);
  let clock = 0;
  const catalog = new LibraryCatalog({ ttlMs: 10, now: () => clock });
  assert.equal((await catalog.get(library)).items.size, 4);
  await mkdir(path.join(library, 'images', 'g.info'));
  await writeFile(path.join(library, 'images', 'g.info', 'metadata.json'), JSON.stringify({ id: 'g', ext: 'jpg', folders: ['F3'] }));
  assert.equal((await catalog.get(library)).items.size, 4, 'still fresh');
  clock = 20;
  assert.equal((await catalog.get(library)).items.size, 4, 'stale copy first');
  assert.equal((await catalog.get(library, { fresh: true })).members.get('F3').length, 1);
});
