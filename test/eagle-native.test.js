import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';

const photo = id => ({ id, name: id, ext: 'jpg', width: 100, height: 100, btime: 1, mtime: 1 });
const LIB = '/lib.library';

function fakeEagle(initial) {
  const items = new Map(Object.entries(initial).map(([id, tags]) => [id, { id, name: id, tags: [...tags], star: 0 }]));
  return { library: items, updates: 0,
    async assertLibrary() {},
    async itemInfo(id) { const item = items.get(id); return item && { ...item, tags: [...item.tags] }; },
    async updateItem({ id, tags, star }) {
      this.updates++; const item = items.get(id); item.tags = [...tags]; if (star !== undefined) item.star = star;
    },
    async *items() { for (const item of items.values()) yield { ...item, tags: [...item.tags] }; } };
}

test('Eagle-native culling: decide by item, opt-in task tags, exact revert and library-wide cleanup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eagle-native-'));
  const store = new RunStore(path.join(root, 'runs'));
  const pipeline = { async run(records) {
    const ids = records.map(record => record.unitId);
    return { results: ids.map(unitId => ({ unitId, score: 0.5, flags: unitId === 'unit:b' ? ['blurry'] : [] })),
      groups: [{ id: 'g1', unitIds: ids, suggested: Object.fromEntries(ids.map((id, i) => [id, i ? 'rejected' : 'selected'])),
        ranking: ids.map((unitId, i) => ({ unitId, rank: i + 1, score: 1 - i / 10, reasons: [] })) }] };
  } };
  const api = fakeEagle({ a: ['旅行'], b: ['AI淘汰', 'x'], other: ['AI精选', '保留'] });
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store, api });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (pathname, body) => {
    const response = await fetch(base + pathname, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const finished = async id => {
    for (let i = 0; i < 300; i++) {
      const run = await store.getRun(id);
      if (run?.status !== 'running') return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('run did not finish');
  };
  const scope = { type: 'folder', label: '旅行', folderId: 'F1' };
  const first = await call('/runs', { libraryPath: LIB, scope, items: ['a', 'b'].map(photo) });
  const runId = first.body.id;
  assert.equal((await finished(runId)).status, 'completed');
  const tagsOf = id => api.library.get(id).tags;
  const human = async () => Object.fromEntries((await new DecisionsStore(store.dir(runId)).read()).map(row => [row.unitId, row.action]));

  const info = await call(`/items/a/analysis?libraryPath=${encodeURIComponent(LIB)}`);
  assert.equal(info.status, 200);
  assert.deepEqual(info.body.groupItemIds, ['a', 'b']); assert.equal(info.body.bestItemId, 'a');
  assert.equal(info.body.eagleTagsEnabled, false);

  const queue = await call(`/runs/${runId}/queue?mode=rejects`);
  assert.deepEqual(queue.body.items.map(row => row.primaryItemId), ['b']);
  assert.equal(queue.body.counts.issues, 1); assert.equal(queue.body.counts.all, 2);
  assert.equal((await call(`/runs/${runId}/queue?mode=nope`)).status, 400);

  assert.equal((await call('/items/b/decision', { libraryPath: LIB, action: 'selected' })).status, 200);
  assert.deepEqual(await human(), { 'unit:b': 'selected' });
  assert.equal(api.updates, 0, 'tags stay untouched until the task opts in');
  assert.equal((await call('/items/b/decision', { libraryPath: LIB, action: 'bogus' })).status, 400);
  assert.equal((await call('/items/missing/decision', { libraryPath: LIB, action: 'selected' })).body.pending, true);
  await call('/items/missing/decision', { libraryPath: LIB, action: 'clear' });
  assert.equal((await call('/items/b/decision', { action: 'selected' })).status, 400);

  const enabled = await call(`/runs/${runId}/eagle-tags`, { enabled: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(tagsOf('a').sort(), ['AI精选', '旅行'].sort());
  assert.deepEqual(tagsOf('b').sort(), ['AI精选', 'AI模糊', 'x'].sort(), 'human decision overrides the suggestion');
  assert.deepEqual(tagsOf('other'), ['AI精选', '保留'], 'items outside the task are untouched');
  assert.equal((await call(`/items/a/analysis?libraryPath=${encodeURIComponent(LIB)}`)).body.eagleTagsEnabled, true);

  await call('/items/a/decision', { libraryPath: LIB, action: 'rejected' });
  assert.ok(tagsOf('a').includes('AI淘汰') && !tagsOf('a').includes('AI精选'), 'decisions update tags while enabled');
  await call('/items/a/decision', { libraryPath: LIB, action: 'clear' });
  assert.deepEqual(await human(), { 'unit:b': 'selected' });
  assert.ok(tagsOf('a').includes('AI精选'), 'clearing returns to the AI suggestion');
  await call(`/runs/${runId}/decisions`, { decisions: [{ unitId: 'unit:a', action: 'candidate', flags: [] }] });
  assert.ok(tagsOf('a').includes('AI候选'), 'plugin decisions also sync tags while enabled');

  const disabled = await call(`/runs/${runId}/eagle-tags`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.deepEqual(tagsOf('a'), ['旅行']);
  assert.deepEqual(tagsOf('b').sort(), ['AI淘汰', 'x'].sort(), 'revert restores the exact pre-write tags');
  const updates = api.updates;
  await call('/items/a/decision', { libraryPath: LIB, action: 'rejected' });
  assert.equal(api.updates, updates, 'no tag writes after the task opts out');

  const dry = await call('/eagle/clear-ai-tags', { libraryPath: LIB, dryRun: true });
  assert.deepEqual([dry.body.scanned, dry.body.changed], [3, 2]);
  assert.deepEqual(tagsOf('b').sort(), ['AI淘汰', 'x'].sort(), 'dry run changes nothing');
  const cleared = await call('/eagle/clear-ai-tags', { libraryPath: LIB, dryRun: false });
  assert.equal(cleared.body.removed, 2);
  assert.deepEqual(tagsOf('b'), ['x']); assert.deepEqual(tagsOf('other'), ['保留']); assert.deepEqual(tagsOf('a'), ['旅行']);
  await call(`/runs/${runId}/eagle-tags`, { enabled: true });
  await call('/eagle/clear-ai-tags', { libraryPath: LIB, dryRun: false });
  assert.equal((await store.getRun(runId)).eagleTagsEnabled, false, 'library cleanup turns the task switch off');

  const second = await call('/runs', { libraryPath: LIB, scope, items: ['a', 'b', 'c'].map(photo) });
  await finished(second.body.id);
  const remapped = await call(`/items/a/analysis?libraryPath=${encodeURIComponent(LIB)}`);
  assert.equal(remapped.body.runId, second.body.id, 'items map to the newest non-superseded task');
});
