import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { PendingDecisions } from '../src/core/pending-decisions.js';
import { STAR_HEADER } from '../src/plugin/star-sync.js';

const LIB = '/lib.library';
const photo = id => ({ id, name: id, ext: 'jpg', width: 100, height: 100, btime: 1, mtime: 1 });

test('decisions on unanalyzed photos wait and join the first analysis that covers them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pending-decisions-'));
  const store = new RunStore(path.join(root, 'runs'));
  const pipeline = { async run(records) {
    const ids = records.map(record => record.unitId);
    return { results: ids.map(unitId => ({ unitId, score: 0.5, flags: [] })),
      groups: [{ id: 'g1', unitIds: ids, suggested: Object.fromEntries(ids.map(id => [id, 'candidate'])),
        ranking: ids.map((unitId, i) => ({ unitId, rank: i + 1, score: 1 - i / 10, reasons: [] })) }] };
  } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (pathname, body, headers = {}) => {
    const response = await fetch(base + pathname, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const analysis = id => call(`/items/${id}/analysis?libraryPath=${encodeURIComponent(LIB)}`);

  const saved = await call('/items/c/decision', { libraryPath: LIB, action: 'selected' }, { [STAR_HEADER]: '1' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.pending, true);
  assert.deepEqual(saved.body.eagleStars, [{ id: 'c', star: 5, record: false }]);
  const before = await analysis('c');
  assert.equal(before.status, 404);
  assert.equal(before.body.pending.action, 'selected');

  const echo = await call('/items/c/decision', { libraryPath: LIB, action: 'selected', via: 'eagle-star' });
  assert.equal(echo.body.unchanged, true, 'the other window reporting the same star is not a new decision');
  const tagged = await call('/items/d/decision', { libraryPath: LIB, action: 'record', via: 'eagle-tag' }, { [STAR_HEADER]: '1' });
  assert.deepEqual(tagged.body.eagleStars, [{ id: 'd', star: 0 }], 'the tag is already in Eagle; only the star follows');
  await call('/items/e/decision', { libraryPath: LIB, action: 'rejected' });
  await call('/items/e/decision', { libraryPath: LIB, action: 'clear' });
  assert.equal((await analysis('e')).body.pending, undefined);
  assert.equal((await call('/items/f/decision', { libraryPath: LIB, action: 'selected', reason: 'x'.repeat(501) })).status, 400);

  const created = await call('/runs', { libraryPath: LIB, scope: { type: 'folder', label: 'x', folderId: 'F' },
    items: ['c', 'd', 'e'].map(photo) });
  for (let i = 0; i < 300 && (await store.getRun(created.body.id))?.status === 'running'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  const run = await store.getRun(created.body.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.adoptedBeforeAnalysis, 2);
  const rows = await new DecisionsStore(store.dir(run.id)).read();
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.unitId, row.action])), { 'unit:c': 'selected', 'unit:d': 'record' });
  assert.ok(rows.every(row => row.source === 'human' && row.beforeAnalysis));
  const after = await analysis('c');
  assert.equal(after.status, 200);
  assert.equal(after.body.humanDecided, true);
  assert.equal(after.body.action, 'selected');
  assert.equal(await store.pendingDecisions.get(LIB, 'c'), null, 'adopted marks leave the pending list');
});

test('adopting keeps a newer decision the run already has and picks the newest mark per unit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pending-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = new PendingDecisions(path.join(root, 'pending.json'));
  const target = new DecisionsStore(path.join(root, 'run'));
  await target.write([{ contractVersion: 1, unitId: 'u1', action: 'rejected', source: 'human', updatedAt: '2026-01-03T00:00:00.000Z' }]);
  await pending.decide(LIB, 'a', { action: 'selected' }, { now: new Date('2026-01-02T00:00:00Z') });
  await pending.decide(LIB, 'b', { action: 'candidate' }, { now: new Date('2026-01-01T00:00:00Z') });
  await pending.decide(LIB, 'c', { action: 'selected' }, { now: new Date('2026-01-01T00:00:00Z') });
  await pending.decide(LIB, 'd', { action: 'record' }, { now: new Date('2026-01-02T00:00:00Z') });
  await pending.decide('/other.library', 'c', { action: 'rejected' });
  const count = await pending.adopt(LIB, [{ id: 'u1', itemIds: ['a'] }, { id: 'u2', itemIds: ['c', 'd'] }], target);
  assert.equal(count, 1);
  assert.deepEqual(Object.fromEntries((await target.read()).map(row => [row.unitId, row.action])), { u1: 'rejected', u2: 'record' });
  assert.equal(await pending.get(LIB, 'a'), null, 'superseded by the newer decision, so it is dropped');
  assert.equal((await pending.get(LIB, 'b')).action, 'candidate', 'photos outside the run keep waiting');
  assert.equal((await pending.get('/other.library', 'c')).action, 'rejected');
});
