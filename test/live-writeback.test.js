import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveWriteback, ensureSmartFolders, LIVE_KEYS } from '../src/plugin/live-writeback.js';
import { handleReviewRoute } from '../src/server/review-routes.js';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';

function storage(values = {}) {
  const map = new Map(Object.entries(values));
  return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
}
test('live writeback is off by default and disabling cancels queued writes', async () => {
  const saved = storage(); let writes = 0;
  const queue = createLiveWriteback({ api: async () => { writes++; }, storage: saved });
  queue.schedule('r', ['a']); await queue.flush(); assert.equal(writes, 0);
  saved.setItem(LIVE_KEYS.enabled, '1'); queue.schedule('r', ['a']);
  saved.setItem(LIVE_KEYS.enabled, '0'); await queue.flush(); assert.equal(writes, 0);
});
test('debounce merges repeated units and an undo sends the newest server decision', async () => {
  const saved = storage({ [LIVE_KEYS.enabled]: '1' }); const requests = [];
  const timers = new Map(); let timerId = 0, newest = 'selected';
  const queue = createLiveWriteback({ storage: saved, setTimer: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimer: id => timers.delete(id), api: async (_url, options) => {
      requests.push({ ...JSON.parse(options.body), newest }); return { results: [] };
    } });
  queue.schedule('r', ['a']); queue.schedule('r', ['a', 'b']); newest = 'clear'; queue.schedule('r', ['a']);
  assert.equal(timers.size, 1); assert.equal(requests.length, 0);
  [...timers.values()][0](); await queue.flush();
  assert.deepEqual(requests, [{ unitIds: ['a', 'b'], star: false, newest: 'clear' }]);
});
test('failed live updates show one notice and remain retryable without blocking review', async () => {
  const saved = storage({ [LIVE_KEYS.enabled]: '1' }); const notices = [];
  let failing = true, writes = 0;
  const queue = createLiveWriteback({ storage: saved, onStatus: (message, error) => notices.push({ message, error }),
    api: async () => { writes++; if (failing) throw new Error('offline'); return { results: [] }; } });
  queue.schedule('r', ['a']); await queue.flush(); await queue.flush();
  assert.equal(notices.length, 1); assert.equal(writes, 2);
  failing = false; await queue.flush(); assert.equal(notices.at(-1).error, false);
  await queue.cancel();
});
test('smart folders use the tags schema, reuse matching names and create only once', async () => {
  const saved = storage({ [LIVE_KEYS.enabled]: '1' }); const calls = [];
  const eagle = { library: { id: 'fake' }, smartFolder: {
    getAll: async () => [{ name: 'AI精选' }], getRules: async () => ({ tags: { methods: ['contain'], valueType: 'array' } }),
    create: async options => calls.push(options)
  } };
  await ensureSmartFolders(eagle, saved); await ensureSmartFolders(eagle, saved);
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'AI待淘汰');
  assert.deepEqual(calls[0].conditions, [{ match: 'AND', rules: [{ property: 'tags', method: 'contain', value: ['AI淘汰'] }] }]);
  const notices = []; const missing = storage({ [LIVE_KEYS.enabled]: '1' });
  await ensureSmartFolders({}, missing, message => notices.push(message));
  await ensureSmartFolders({}, missing, message => notices.push(message));
  assert.equal(notices.length, 1);
  const off = storage(); await ensureSmartFolders(eagle, off); assert.equal(calls.length, 1);
});

test('partial live failures still expose successful history for finish-dialog revert', async () => {
  const applied = [], notices = [];
  const queue = createLiveWriteback({ storage: storage({ [LIVE_KEYS.enabled]: '1' }),
    api: async () => ({ results: [{ id: 'a', ok: true }, { id: 'b', ok: false }] }),
    onApplied: runId => applied.push(runId), onStatus: (_message, error) => notices.push(error) });
  queue.schedule('run', ['a', 'b']); await queue.flush();
  assert.deepEqual(applied, ['run']); assert.deepEqual(notices, [true]);
  await queue.cancel();
});
test('live route targets only requested units, never replaces existing stars, and fully reverts every live cycle', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'w24-live-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(path.join(directory, 'runs'));
  const data = { run: { id: 'live-test', status: 'completed' },
    units: ['a', 'b', 'c'].map(id => ({ id: `u:${id}`, itemIds: [id], primaryItemId: id })),
    results: ['a', 'b', 'c'].map(id => ({ unitId: `u:${id}`, flags: [] })),
    items: ['a', 'b', 'c'].map(id => ({ id, tags: ['用户', ...(id === 'a' ? ['AI候选'] : [])], star: id === 'b' ? 3 : 0 })),
    groups: [{ id: 'g', unitIds: ['u:a', 'u:b', 'u:c'], suggested: { 'u:a': 'selected', 'u:b': 'candidate' } }] };
  await store.save(data.run, data);
  const live = new Map(data.items.map(item => [item.id, structuredClone(item)])); const writes = [], responses = [];
  const ctx = { runStore: store, readBody: async req => req.body, json: (_res, status, body) => responses.push({ status, body }),
    api: { itemInfo: async id => structuredClone(live.get(id)), updateItem: async row => {
      writes.push(row); Object.assign(live.get(row.id), row);
    } } };
  const decisions = new DecisionsStore(store.dir(data.run.id));
  const save = rows => decisions.upsert(rows.map(row => ({ source: 'human', ...row })));
  const request = (endpoint, body = {}) => handleReviewRoute({ method: 'POST', url: `/runs/live-test/${endpoint}`, body }, {}, ctx);
  await save([{ unitId: 'u:a', action: 'selected' }, { unitId: 'u:b', action: 'selected' }]);
  await request('writeback/live', { unitIds: ['u:a', 'u:b'], star: true });
  assert.equal(live.get('a').star, 5); assert.equal(live.get('b').star, 3);
  assert.deepEqual(live.get('c'), data.items[2]);
  await save([{ unitId: 'u:a', action: 'rejected' }]); await request('writeback/live', { unitIds: ['u:a'], star: true });
  assert.equal(live.get('a').star, 5); assert.ok(live.get('a').tags.includes('AI淘汰'));
  await save([{ unitId: 'u:a', clear: true }]); await request('writeback/live', { unitIds: ['u:a'], star: true });
  assert.deepEqual(live.get('a'), data.items[0]);
  await save([{ unitId: 'u:a', action: 'selected' }]); await request('writeback/live', { unitIds: ['u:a'], star: true });
  await request('apply', { apply: true }); // Final writeback must retain the live baseline.
  await request('writeback/revert');
  for (const item of data.items) assert.deepEqual(live.get(item.id), item);
  const count = writes.length; await request('writeback/revert'); assert.equal(writes.length, count);
  await request('writeback/live', { unitIds: ['unknown'] }); assert.equal(responses.at(-1).status, 400);
});
