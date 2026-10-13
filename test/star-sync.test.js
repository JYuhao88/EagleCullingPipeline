import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { applyEagleStars, createStarWatcher, STAR_ACTIONS, STAR_SYNC_KEY, starLabel, takeOwnWrite } from '../src/plugin/star-sync.js';
import { createApi } from '../src/plugin/api.js';

const memory = (values = {}) => {
  const map = new Map(Object.entries(values));
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)) };
};

function fakeLibrary(stars) {
  const items = new Map(Object.entries(stars).map(([id, star]) => [id, { id, star }]));
  let selected = [];
  return { items, select(ids) { selected = ids; },
    item: {
      async countSelected() { return selected.length; },
      async getSelected() { return selected.map(id => ({ ...items.get(id) })); },
      async getByIds(ids) { return ids.map(id => ({ ...items.get(id) })); }
    } };
}

test('star keys match Eagle ratings everywhere', () => {
  assert.deepEqual([5, 4, 3, 2, 1, 0].map(star => STAR_ACTIONS[star]),
    ['selected', 'selected', 'candidate', 'rejected', 'rejected', 'clear']);
  assert.equal(starLabel(3), '★★★☆☆'); assert.equal(starLabel(0), '未打星');
});

test('star watcher: first sight is a baseline, later ratings become decisions, Shift+number advance is caught', async () => {
  const eagle = fakeLibrary({ a: 4, b: 0, c: 0 });
  const posts = [];
  const watcher = createStarWatcher({ eagle, storage: memory(), post: async change => { posts.push(change); } });
  eagle.select(['a']);
  assert.deepEqual(await watcher.tick(), [], 'a pre-existing 4★ is not a decision');
  eagle.items.get('a').star = 5;
  await watcher.tick();
  assert.deepEqual(posts.map(row => [row.id, row.action]), [['a', 'selected']]);
  eagle.select(['b']); await watcher.tick();
  // Shift+1 rates b and moves the selection to c before the next poll.
  eagle.items.get('b').star = 1; eagle.select(['c']);
  await watcher.tick();
  assert.deepEqual(posts.map(row => [row.id, row.action]), [['a', 'selected'], ['b', 'rejected']]);
  eagle.items.get('a').star = 0; await watcher.tick();
  assert.deepEqual(posts.at(-1), { id: 'a', star: 0, before: 5, action: 'clear' });
});

test('star watcher retries a failed save, stays off when disabled and skips huge selections', async () => {
  const eagle = fakeLibrary({ a: 0 });
  let fail = true; const posts = [];
  const watcher = createStarWatcher({ eagle, storage: memory(), post: async change => {
    if (fail) throw new Error('offline'); posts.push(change.action);
  } });
  eagle.select(['a']); await watcher.tick();
  eagle.items.get('a').star = 3; await watcher.tick();
  fail = false; await watcher.tick();
  assert.deepEqual(posts, ['candidate']);

  const off = createStarWatcher({ eagle, storage: memory({ [STAR_SYNC_KEY]: '0' }), post: async () => assert.fail() });
  assert.deepEqual(await off.tick(), []);

  const many = fakeLibrary(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`m${i}`, 0])));
  let reads = 0; const getSelected = many.item.getSelected;
  many.item.getSelected = async () => { reads++; return getSelected(); };
  many.select(['m0', 'm1', 'm2', 'm3', 'm4']);
  await createStarWatcher({ eagle: many, storage: memory(), maxSelected: 3, post: async () => {} }).tick();
  assert.equal(reads, 0);
});

test('applyEagleStars saves only changed ratings and reports failures as a warning', async () => {
  const saved = [];
  const item = (id, star) => ({ id, star, async save() { saved.push([this.id, this.star]); } });
  const eagle = { item: { async getByIds(ids) { return ids.map(id => item(id, id === 'a' ? 5 : 2)); } } };
  assert.equal(await applyEagleStars(eagle, [{ id: 'a', star: 5 }, { id: 'b', star: 0 }]), null);
  assert.deepEqual(saved, [['b', 0]]);
  const broken = { item: { async getByIds() { throw new Error('busy'); } } };
  assert.match(await applyEagleStars(broken, [{ id: 'a', star: 1 }]), /星级未更新：busy/);
});

test('star writes for one item land in order with the newest star, and are not read back as decisions', async () => {
  const stored = new Map([['q', 0]]); let slow = true;
  const eagle = { item: { async getByIds(ids) {
    return ids.map(id => ({ id, star: stored.get(id), async save() {
      const value = this.star;
      if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 30)); }
      stored.set(id, value);
    } }));
  } } };
  await Promise.all([applyEagleStars(eagle, [{ id: 'q', star: 5 }]), applyEagleStars(eagle, [{ id: 'q', star: 1 }])]);
  assert.equal(stored.get('q'), 1, 'a slow earlier save cannot overwrite the later decision');
  assert.equal(takeOwnWrite('q', 1), true); assert.equal(takeOwnWrite('q', 1), false);

  const library = fakeLibrary({ w: 0 }); const posts = [];
  library.item.getByIds = async ids => ids.map(id => ({ id, star: library.items.get(id).star,
    async save() { library.items.get(id).star = this.star; } }));
  const watcher = createStarWatcher({ eagle: library, storage: memory(), post: async change => { posts.push(change.action); } });
  library.select(['w']); await watcher.tick();
  await applyEagleStars(library, [{ id: 'w', star: 3 }]);
  await watcher.tick();
  assert.deepEqual(posts, [], 'the plugin\'s own star is not a new decision');
  library.items.get('w').star = 1; await watcher.tick();
  assert.deepEqual(posts, ['rejected']);
});

test('plugin POSTs carry the star header only while star sync is on', async t => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { seen.push(options.headers || {}); return new Response('{}'); };
  t.after(() => { globalThis.fetch = original; });
  await createApi('http://x', memory())('/a', { method: 'POST', headers: { 'content-type': 'application/json' } });
  await createApi('http://x', memory())('/a');
  await createApi('http://x', memory({ [STAR_SYNC_KEY]: '0' }))('/a', { method: 'POST' });
  assert.deepEqual(seen.map(headers => headers['x-eagle-stars'] || null), ['1', null, null]);
  assert.equal(seen[0]['content-type'], 'application/json');
});

test('decisions write Eagle stars on request; ratings read from Eagle are saved without echo', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'star-sync-'));
  const store = new RunStore(path.join(root, 'runs'));
  const pipeline = { async run(records) {
    const ids = records.map(record => record.unitId);
    return { results: ids.map(unitId => ({ unitId, score: 0.5, flags: [] })),
      groups: [{ id: 'g1', unitIds: ids, suggested: Object.fromEntries(ids.map((id, i) => [id, i ? 'rejected' : 'selected'])),
        ranking: ids.map((unitId, i) => ({ unitId, rank: i + 1, score: 1 - i / 10, reasons: [] })) }] };
  } };
  const library = new Map([['a', { id: 'a', tags: ['旅行'], star: 2 }], ['b', { id: 'b', tags: [], star: 0 }],
    ['b-raw', { id: 'b-raw', tags: [], star: 0 }]]);
  const writes = [];
  const api = { async assertLibrary() {},
    async itemInfo(id) { const item = library.get(id); return item && { ...item, tags: [...item.tags] }; },
    async updateItem(update) { writes.push(update); Object.assign(library.get(update.id), update); } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store, api });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (pathname, body, headers = {}) => {
    const response = await fetch(base + pathname, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const preflight = await fetch(`${base}/items/a/decision`, { method: 'OPTIONS' });
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-eagle-stars/);
  const created = await call('/runs', { libraryPath: '/lib.library', scope: { type: 'folder', label: 'x' },
    items: [...['a', 'b'].map(id => ({ id, name: id, ext: 'jpg', width: 100, height: 100, btime: 1, mtime: 1 })),
      { id: 'b-raw', name: 'b', ext: 'cr3', width: 100, height: 100, btime: 1, mtime: 1 }] });
  const runId = created.body.id;
  for (let i = 0; i < 300 && (await store.getRun(runId))?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  const human = async () => Object.fromEntries((await new DecisionsStore(store.dir(runId)).read())
    .filter(row => row.source === 'human').map(row => [row.unitId, row.action]));
  const decide = (id, action, extra = {}, headers = {}) =>
    call(`/items/${id}/decision`, { libraryPath: '/lib.library', action, ...extra }, headers);

  assert.equal((await decide('a', 'candidate')).body.eagleStars, undefined, 'no stars without the header');
  const picked = await decide('a', 'selected', {}, { 'x-eagle-stars': '1' });
  assert.deepEqual(picked.body.eagleStars, [{ id: 'a', star: 5 }]);
  assert.deepEqual(writes, [], 'the service never writes stars through the Web API');

  const echo = await decide('a', 'selected', { via: 'eagle-star' }, { 'x-eagle-stars': '1' });
  assert.equal(echo.body.unchanged, true, 'our own star coming back is a no-op');
  assert.equal((await decide('b', 'clear', { via: 'eagle-star' })).body.unchanged, true);
  const fromEagle = await decide('b', 'rejected', { via: 'eagle-star' }, { 'x-eagle-stars': '1' });
  assert.deepEqual(fromEagle.body.eagleStars, [{ id: 'b-raw', star: 1 }], 'only the RAW of the pair follows the JPEG rating');
  assert.deepEqual(await human(), { 'unit:a': 'selected', 'unit:b': 'rejected' });

  const cleared = await call(`/runs/${runId}/decisions`, { decisions: [{ unitId: 'unit:b', clear: true }] }, { 'x-eagle-stars': '1' });
  assert.deepEqual(cleared.body.eagleStars, [{ id: 'b', star: 0 }, { id: 'b-raw', star: 0 }]);
  assert.deepEqual(await human(), { 'unit:a': 'selected' });
});
