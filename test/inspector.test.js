import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/server/run-store.js';
import { ItemAnalysisIndex, createItemAnalysisRouter } from '../src/server/item-analysis.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { groupSummary, inspectorModel } from '../src/plugin/inspector/inspector.js';
import { checkUpdateVersion } from '../scripts/check-update-version.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'inspector-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  const save = async (id, date, libraryPath = '/fixture.library') => store.save({ id, startedAt: date, status: 'completed', libraryPath,
    scope: { label: '旅行' } }, { units: [{ id: 'u1', itemIds: ['photo', 'raw'], primaryItemId: 'photo' }], items: [],
    results: [{ unitId: 'u1', flags: ['eyes-closed', 'possibly-blurry'], metrics: { quality: null }, focus: { eyeSharpnessNative: 120 } }],
    groups: [{ id: 'g1', unitIds: ['u1'], suggested: { u1: 'rejected' }, ranking: [{ unitId: 'u1', rank: 1, score: .7, reasons:
      ['闭眼'] }] }] });
  return { store, save };
}
test('item index hits paired IDs in latest matching library, misses clearly, and invalidates on publication', async t => {
  const { store, save } = await fixture(t);
  await save('run-a', '2026-10-01'); await save('run-other', '2026-10-04', '/other.library');
  const index = new ItemAnalysisIndex(store); let builds = 0;
  const original = index.build.bind(index); index.build = async key => { builds++; return original(key); };
  const row = await index.get('photo', '/fixture.library');
  assert.equal(row.runId, 'run-a'); assert.equal(row.suggested, 'rejected'); assert.equal(row.focus, '可能模糊');
    assert.equal(row.quality, null);
  assert.equal((await index.get('raw', '/fixture.library')).unitId, 'u1');
  assert.equal(await index.get('missing', '/fixture.library'), null); assert.equal(builds, 1);
  await new DecisionsStore(store.dir('run-a')).upsert([{ unitId: 'u1', action: 'selected', reason: '保留' }]);
  const human = await index.get('photo', '/fixture.library'); assert.equal(human.humanDecided, true); assert.equal(human.action,
    'selected'); assert.equal(builds, 1);
  await save('run-new', '2026-10-03');
  assert.equal((await index.get('photo', '/fixture.library')).runId, 'run-new'); assert.equal(builds, 2);
  await store.saveProgress({ id: 'run-pending', status: 'running', libraryPath: '/fixture.library' });
  assert.equal((await index.get('photo', '/fixture.library')).runId, 'run-new'); assert.equal(builds, 3);
  await store.saveProgress({ id: 'run-pending', status: 'running', libraryPath: '/fixture.library', progress: { completed: 1 } });
  await index.get('photo', '/fixture.library'); assert.equal(builds, 3);
});
test('read-only item route returns 200, explicit 404, missing library 400 and refuses writes', async t => {
  const { store, save } = await fixture(t); await save('run-a', '2026-10-01');
  const route = createItemAnalysisRouter(store);
  async function request(item, method = 'GET', query = '?libraryPath=/fixture.library') {
    let code, value; const res = { writeHead: status => { code = status; }, end: text => { value = JSON.parse(text); } };
    await route({ method }, res, new URL(`http://localhost/items/${item}/analysis${query}`)); return { code, value };
  }
  assert.equal((await request('photo')).code, 200);
  const missing = await request('missing'); assert.equal(missing.code, 404); assert.match(missing.value.error, /尚未分析/);
  assert.equal((await request('photo', 'POST')).code, 405);
  assert.equal((await request('photo', 'GET', '')).code, 400);
});
test('item analysis lists the whole group in rank order with AI suggestion, human decision and flags', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'inspector-group-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  await store.save({ id: 'run-g', startedAt: '2026-10-01', status: 'completed', libraryPath: '/fixture.library' }, {
    units: [{ id: 'u1', itemIds: ['p1', 'r1'], primaryItemId: 'p1' }, { id: 'u2', primaryItemId: 'p2' },
      { id: 'u3', primaryItemId: 'p3' }], items: [],
    results: [{ unitId: 'u1', flags: [] }, { unitId: 'u2', flags: ['blurry'] }, { unitId: 'u3', flags: [] }],
    groups: [{ id: 'g1', unitIds: ['u1', 'u2', 'u3'], confidence: 'low',
      suggested: { u1: 'candidate', u2: 'rejected', u3: 'selected' },
      ranking: [{ unitId: 'u3', rank: 1 }, { unitId: 'u1', rank: 2 }, { unitId: 'u2', rank: 3 }] }] });
  await new DecisionsStore(store.dir('run-g')).upsert([{ unitId: 'u2', action: 'rejected', source: 'human' }]);
  const row = await new ItemAnalysisIndex(store).get('r1', '/fixture.library');
  assert.deepEqual(row.groupMembers.map(member => [member.unitId, member.rank, member.suggested, member.human]),
    [['u3', 1, 'selected', null], ['u1', 2, 'candidate', null], ['u2', 3, 'rejected', 'rejected']]);
  assert.deepEqual(row.groupMembers[1].itemIds, ['p1', 'r1']); assert.deepEqual(row.groupMembers[2].flags, ['blurry']);
  assert.deepEqual(row.groupMembers[0].metrics, { score: null, quality: null, aesthetic: null, sharpness: null, eye: null, exposure: null,
    clipped: null, faces: null, eyesClosed: null, eyesOpen: null, faceSize: null, similar: null });
  assert.equal(groupSummary(row), '第 1 组 · 3 张 · AI 建议 精选 1 · 候选 1 · 淘汰 1 · 已定 1/3 · 分组没把握，建议确认');
  assert.equal(groupSummary({ groupMembers: [{ unitId: 'u1' }] }), '单张，无需对比');
});
test('inspector group strip selects a whole unit in Eagle and stars typed in Eagle become decisions', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, dataset: {}, listeners: {},
    classList: { names: new Set(), add(name) { this.names.add(name); }, toggle() {} },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    addEventListener(type, handler) { this.listeners[type] = handler; } });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element };
  const items = { p1: { id: 'p1', star: 0 } }, selections = [], posts = [];
  const eagle = { library: { path: '/fixture.library' }, item: {
    getSelected: async () => [items.p1], getByIds: async ids => ids.map(id => items[id]).filter(Boolean),
    select: async ids => { selections.push(ids); } } };
  const result = { runId: 'run-g', unitId: 'u1', action: 'candidate', groupSize: 2, runName: '旅行', focus: '清晰', groupIndex: 0,
    groupMembers: [{ unitId: 'u3', itemIds: ['p3'], rank: 1, suggested: 'selected', human: null, flags: [] },
      { unitId: 'u1', itemIds: ['p1', 'r1'], rank: 2, suggested: 'candidate', human: 'candidate', flags: ['blurry'] }] };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return { ok: true, status: 200, json: async () => ({ eagleStars: [] }) }; }
    return { ok: true, status: 200, json: async () => result };
  };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl });
  try {
    await view.refresh(true); await new Promise(resolve => setTimeout(resolve, 10));
    const pair = root.querySelector('#pair');
    assert.equal(pair.hidden, false); assert.equal(pair.children.length, 2);
    const [current, best] = pair.children;
    assert.ok(current.classList.names.has('current')); assert.ok(!best.classList.names.has('current'));
    assert.match(best.children[0].src, /\/runs\/run-g\/preview\/u3$/);
    assert.deepEqual(current.children.map(node => node.textContent).slice(1), ['当前 · 第 2 名 · 候', '★3', '模糊']);
    assert.equal(best.children[1].textContent, '第 1 名 · 精');
    best.listeners.click(); assert.deepEqual(selections, [['p3']]);
    view.watcher.stop(); view.watcher.reset();
    await view.watcher.tick(); items.p1.star = 5; await view.watcher.tick();
    assert.equal(posts.length, 1); assert.match(posts[0].url, /\/items\/p1\/decision$/);
    assert.deepEqual(posts[0].body, { libraryPath: '/fixture.library', action: 'selected', via: 'eagle-star' });
    assert.equal(posts[0].headers['x-eagle-stars'], '1');
  } finally { view.dispose(); }
});
test('inspector shows run progress, jumps between groups, accepts AI for a group and summarises multi-select', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {},
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element };
  let selected = [{ id: 'b1', star: 0 }];
  const selections = [], posts = [];
  const eagle = { library: { path: '/lib' }, item: { getSelected: async () => selected, getByIds: async () => [],
    select: async ids => { selections.push(ids); } } };
  const queueRow = (unitId, groupIndex, rank, human = null, confidence = null) => ({ unitId, primaryItemId: unitId,
    itemIds: [unitId], groupId: `g${groupIndex}`, groupIndex, rank, suggested: rank === 1 ? 'selected' : 'rejected',
    human, confidence });
  const queue = [queueRow('a1', 0, 1, 'selected'), queueRow('b1', 1, 1), queueRow('b2', 1, 2, 'rejected'),
    queueRow('c1', 2, 1, null, 'low')];
  const analysis = { runId: 'run-1', unitId: 'b1', groupId: 'g1', groupIndex: 1, runName: '旅行', action: 'selected',
    groupSize: 2, focus: '清晰', groupItemIds: ['b1', 'b2'], groupMembers: [
      { unitId: 'b1', itemIds: ['b1'], rank: 1, suggested: 'selected', human: null, flags: [] },
      { unitId: 'b2', itemIds: ['b2'], rank: 2, suggested: 'rejected', human: 'rejected', flags: [] }] };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ decisions: [] }) }; }
    if (url.includes('/queue')) return { ok: true, status: 200, json: async () => ({ queue }) };
    return { ok: true, status: 200, json: async () => analysis };
  };
  const storage = { getItem: key => key === 'eagle-culling-live-writeback' ? '1' : null };
  const view = mountInspector({ root, eagle, storage, fetchImpl });
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    view.watcher.stop();
    await view.refresh(true); await settle();
    assert.equal(root.querySelector('#runProgress').textContent, '旅行 · 已定 2/4 · 精选 1 · 候选 0 · 淘汰 1');
    assert.equal(root.querySelector('#finishHint').hidden, true);
    assert.equal(root.querySelector('#acceptGroup').textContent, '按 AI 建议 1');
    assert.deepEqual(root.querySelector('#neighbours').children.map(node => node.dataset.side), ['prev', 'next']);
    view.navigate('prev'); view.navigate('next'); view.navigate('uncertain');
    assert.deepEqual(selections, [['a1'], ['c1'], ['c1']]);
    await view.acceptGroup();
    assert.match(posts[0].url, /\/runs\/run-1\/decisions$/);
    assert.deepEqual(posts[0].body.decisions.map(row => [row.unitId, row.action]), [['b1', 'selected']]);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.match(posts[1].url, /\/runs\/run-1\/writeback\/live$/); assert.deepEqual(posts[1].body.unitIds, ['b1']);
    selected = [{ id: 'a1' }, { id: 'b1' }, { id: 'b2' }];
    await view.refresh(true); await settle();
    assert.equal(root.querySelector('#status').textContent, '已选 3 张');
    assert.equal(root.querySelector('#selectedCount').textContent, '跨 2 组');
    assert.equal(root.querySelector('#details').hidden, true);
  } finally { view.dispose(); }
});
test('item analysis carries per-photo metrics for the comparison table', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'inspector-metrics-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  await store.save({ id: 'run-m', startedAt: '2026-10-01', status: 'completed', libraryPath: '/fixture.library' }, {
    units: [{ id: 'u1', primaryItemId: 'p1' }, { id: 'u2', primaryItemId: 'p2' }], items: [],
    results: [{ unitId: 'u1', name: 'DSC001', score: .4, flags: [], focus: { eyeSharpnessNative: .8 }, embedding: [1, 0],
      faces: [{ box: [.1, .2, .3, .5], eyesAssessed: true, blinkLeft: .1, blinkRight: .3 }, { box: [.5, .5, .6, .6] }],
      metrics: { quality: .7, sharpness: .2, exposure: .9, clippedHighlights: .01, clippedShadows: .002, faces: 1, eyesClosed: 0 } },
    { unitId: 'u2', flags: [], metrics: {}, embedding: [0.6, 0.8] }],
    groups: [{ id: 'g1', unitIds: ['u1', 'u2'], suggested: { u1: 'selected', u2: 'candidate' },
      ranking: [{ unitId: 'u1', rank: 1, score: .6, reasons: ['综合分最高'] }, { unitId: 'u2', rank: 2, score: .5 }] }] });
  const row = await new ItemAnalysisIndex(store).get('p2', '/fixture.library');
  const metrics = row.groupMembers[0].metrics;
  assert.deepEqual({ ...metrics, eyesOpen: Math.round(metrics.eyesOpen * 100), faceSize: Math.round(metrics.faceSize * 100) },
    { score: .6, quality: .7, aesthetic: null, sharpness: .2, eye: .8, exposure: .9, clipped: .012, faces: 1, eyesClosed: 0,
      eyesOpen: 70, faceSize: 30, similar: null });
  assert.equal(row.groupMembers[0].name, 'DSC001'); assert.deepEqual(row.groupMembers[0].reasons, ['综合分最高']);
  assert.equal(row.groupMembers[1].metrics.clipped, null);
  assert.equal(Math.round(row.groupMembers[1].metrics.similar * 100), 60);
  assert.equal(row.groupMembers[1].metrics.eyesOpen, null);
});
test('inspector fixes groups for the selected photos and undoes only its own fixes', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {},
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element };
  let selected = [{ id: 'b2' }];
  const posts = [];
  const eagle = { library: { path: '/lib' }, item: { getSelected: async () => selected, getByIds: async () => [] } };
  const queueRow = (unitId, groupIndex, rank, extra = {}) => ({ unitId, primaryItemId: unitId, itemIds: [unitId],
    groupId: `g${groupIndex}`, groupIndex, rank, suggested: rank === 1 ? 'selected' : 'candidate', human: null, ...extra });
  const queue = [queueRow('a1', 0, 1), queueRow('b1', 1, 1), queueRow('b2', 1, 2, { unitFlags: ['eyes-closed'] }),
    queueRow('b3', 1, 3, { flags: ['blurry'], unitFlags: [] }), queueRow('c1', 2, 1, { unitFlags: ['blurry'] })];
  const analysis = { runId: 'run-1', unitId: 'b2', groupId: 'g1', groupIndex: 0, runName: '旅行', action: 'candidate',
    groupSize: 3, focus: '清晰', groupMembers: queue.slice(1, 4) };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({}) }; }
    if (url.includes('/queue')) return { ok: true, status: 200, json: async () => ({ queue }) };
    return { ok: true, status: 200, json: async () => analysis };
  };
  let clock = 0;
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl, now: () => clock });
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    view.watcher.stop();
    await view.refresh(true); await settle();
    assert.match(root.querySelector('#groupContext').textContent, /^第 2 组 · 3 张/);
    await view.regroup('prev');
    assert.deepEqual(posts.map(post => [post.url.split('/groups/')[1], post.body]), [['move', { unitId: 'b2', targetGroupId: 'g0' }]]);
    selected = [{ id: 'b2' }, { id: 'b3' }]; await view.refresh(true); await settle();
    await view.regroup('alone');
    assert.deepEqual(posts.at(-1).body, { groupId: 'g1', unitIds: ['b2', 'b3'] });
    await view.regroup('undo');
    assert.deepEqual(posts.slice(-2).map(post => post.url.split('/groups/')[1]), ['undo', 'undo']);
    posts.length = 0; await view.regroup('undo'); assert.equal(posts.length, 0);
    selected = [{ id: 'a1' }, { id: 'b1' }]; await view.refresh(true); await settle();
    await view.regroup('next'); assert.equal(posts.length, 0);
    await view.bulk('eyes'); assert.equal(posts.length, 0);
    clock = 1000; await view.bulk('eyes');
    assert.deepEqual(posts[0].body.decisions, [{ unitId: 'b2', action: 'rejected', reason: '闭眼' }]);
    await view.bulk('blurry'); clock = 6000; await view.bulk('blurry'); assert.equal(posts.length, 1);
    await view.bulk('blurry');
    assert.deepEqual(posts[1].body.decisions.map(row => row.unitId), ['c1']);
  } finally { view.dispose(); }
});
test('inspector survives Eagle reloading it on every photo switch: cached group, carried note, held height', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {}, style: {},
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const sessionData = new Map();
  const session = { getItem: key => sessionData.get(key) ?? null, setItem: (key, value) => sessionData.set(key, value),
    removeItem: key => sessionData.delete(key) };
  const members = [
    { unitId: 'u1', itemIds: ['p1'], rank: 1, suggested: 'selected', human: null, flags: [], metrics: { score: .6 } },
    { unitId: 'u2', itemIds: ['p2', 'r2'], rank: 2, suggested: 'candidate', human: 'rejected', flags: [], metrics: { score: .5 } }];
  const analysis = { runId: 'run-1', unitId: 'u1', groupId: 'g1', groupIndex: 0, runName: '旅行', action: 'selected',
    groupSize: 2, rank: 1, focus: '清晰', groupMembers: members };
  const queue = members.map(member => ({ ...member, primaryItemId: member.itemIds[0], groupId: 'g1', groupIndex: 4 }));
  let fetches = 0, pending = null;
  const fetchImpl = async url => {
    if (url.includes('/queue')) fetches++;
    if (url.includes('/queue')) return { ok: true, status: 200, json: async () => ({ queue }) };
    return new Promise(resolve => { pending = () => resolve({ ok: true, status: 200, json: async () => analysis }); });
  };
  const mount = (id, body) => {
    const nodes = new Map();
    const root = { hidden: false, body, querySelector: key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); },
      querySelectorAll: () => [], createElement: element };
    const eagle = { library: { path: '/lib' }, item: { getSelected: async () => [{ id }], getByIds: async () => [] } };
    return { root, view: mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl, session,
      pageUrl: `file:///inspector/index.html?id=${id}` }) };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const first = mount('p1', { style: {}, scrollHeight: 640 });
  try {
    first.view.watcher.stop(); await settle(); pending(); await settle(); await settle();
    assert.equal(first.root.querySelector('#groupContext').textContent.split(' · ')[0], '第 5 组');
    assert.equal(sessionData.get('eagle-culling-inspector-height'), '640');
    first.view.navigate('next');
  } finally { first.view.dispose(); }
  sessionData.set('eagle-culling-inspector-note', JSON.stringify({ text: '已跳到别处', at: Date.now() }));
  const body = { style: {}, scrollHeight: 0 };
  const queueFetches = fetches;
  const second = mount('r2', body);
  try {
    assert.equal(body.style.minHeight, '');
    assert.equal(second.root.querySelector('#actionStatus').textContent, '已跳到别处');
    assert.equal(sessionData.has('eagle-culling-inspector-note'), false);
    assert.equal(second.root.querySelector('#status').textContent, '淘汰 · 已人工决定');
    assert.equal(second.root.querySelector('#position').textContent, '第 2 / 2 名');
    second.view.watcher.stop(); await settle(); pending(); await settle();
    assert.equal(fetches - queueFetches, 0);
  } finally { second.view.dispose(); }
});
test('inspector keeps the top K of a large group after a second click and leaves your decisions alone', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {}, style: {},
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element };
  const members = Array.from({ length: 6 }, (_, index) => ({ unitId: `u${index + 1}`, itemIds: [`p${index + 1}`],
    rank: index + 1, suggested: index ? 'candidate' : 'selected', human: index === 4 ? 'selected' : null, flags: [],
    metrics: { score: 0.6 - index / 50 } }));
  const analysis = { runId: 'run-k', unitId: 'u2', groupId: 'g', groupIndex: 0, runName: '连拍', action: 'candidate',
    groupSize: 6, rank: 2, focus: '清晰', groupMembers: members };
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({}) }; }
    if (url.includes('/queue')) return { ok: true, status: 200, json: async () => ({ queue: [] }) };
    return { ok: true, status: 200, json: async () => analysis };
  };
  const sessionData = new Map();
  const session = { getItem: key => sessionData.get(key) ?? null, setItem: (key, value) => sessionData.set(key, value),
    removeItem: key => sessionData.delete(key) };
  let clock = 0;
  const eagle = { library: { path: '/lib' }, item: { getSelected: async () => [{ id: 'p2' }], getByIds: async () => [] } };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl, session, now: () => clock,
    pageUrl: 'file:///x' });
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    view.watcher.stop(); await view.refresh(true); await settle();
    assert.equal(root.querySelector('#selectedCount').textContent, '第 1 组 · 已定 1/6');
    assert.equal(root.querySelector('#groupChart').hidden, true);
    assert.equal(root.querySelector('#keepCount').textContent, '3');
    view.stepKeep(-1);
    assert.equal(root.querySelector('#keepCount').textContent, '2');
    assert.equal(root.querySelector('#keepApply').textContent, '其余 3 张淘汰');
    await view.applyKeep(); assert.equal(posts.length, 0);
    clock = 1000; await view.applyKeep();
    assert.deepEqual(posts[0].decisions.map(row => [row.unitId, row.action]),
      [['u1', 'selected'], ['u2', 'candidate'], ['u3', 'rejected'], ['u4', 'rejected'], ['u6', 'rejected']]);
  } finally { view.dispose(); }
});
test('inspector moves its Eagle section above 标签 once and then respects a dragged order', async () => {
  const { placeInspectorFirst } = await import('../src/plugin/inspector/inspector.js');
  const manifest = JSON.parse(await readFile(new URL('../src/plugin/manifest.json', import.meta.url), 'utf8'));
  const data = new Map([['eagle.inspector.itemsOrder',
    JSON.stringify({ tags: 0, folders: 1, annotations: 2, information: 100, [manifest.id]: 101 })]]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.equal(placeInspectorFirst(storage), true);
  assert.deepEqual(JSON.parse(data.get('eagle.inspector.itemsOrder')),
    { tags: 0, folders: 1, annotations: 2, information: 100, [manifest.id]: -1 });
  data.set('eagle.inspector.itemsOrder', JSON.stringify({ tags: 0, [manifest.id]: 1, folders: 2 }));
  assert.equal(placeInspectorFirst(storage), false);
  data.clear();
  assert.equal(placeInspectorFirst(storage), true);
  assert.equal(JSON.parse(data.get('eagle.inspector.itemsOrder'))[manifest.id], -1);
  data.clear();
  data.set('eagle-culling-inspector-placement', 'top-1');
  data.set('eagle.inspector.itemsOrder', JSON.stringify({ tags: 0, 'com.eagle.culling': 1, folders: 2 }));
  assert.equal(placeInspectorFirst(storage), true);
  assert.deepEqual(JSON.parse(data.get('eagle.inspector.itemsOrder')), { tags: 0, folders: 2, [manifest.id]: 1 });
});
test('plugin ids work as a jQuery id selector so Eagle reuses the inspector webview', async () => {
  for (const file of ['src/plugin/manifest.json', 'src/inspector/manifest.json']) {
    assert.match(JSON.parse(await readFile(file, 'utf8')).id, /^[a-z][a-z0-9-]*$/);
  }
});
test('group members carry face boxes with the blink verdict and the 17 body keypoints for thumbnail marks', async () => {
  const { memberMarks } = await import('../src/server/item-analysis.js');
  const points = Array.from({ length: 133 }, (_, index) => [index / 200, 0.123456, 0.9]);
  const marks = memberMarks({ faces: [{ box: [0.1, 0.2, 0.3, 0.4], eyesAssessed: true, eyesClosed: true },
    { box: [0.5, 0.5, 0.6, 0.6] }, { box: null }],
  signals: { persons: [{ box: [0, 0.1, 0.5, 0.9], isMain: true, keypoints: { points } }] } });
  assert.deepEqual(marks.faces, [{ box: [0.1, 0.2, 0.3, 0.4], closed: true }, { box: [0.5, 0.5, 0.6, 0.6] }]);
  assert.equal(marks.persons[0].main, true);
  assert.equal(marks.persons[0].points.length, 17);
  assert.deepEqual(marks.persons[0].points[2], [0.01, 0.123, 0.9]);
  assert.equal(memberMarks({ faces: [] }), null);
});
test('inspector view model covers empty, loading, offline and compact score/reasons without inventing quality', () => {
  assert.match(inspectorModel({ state: 'empty' }).badge, /尚未分析/);
  assert.equal(inspectorModel({ state: 'offline' }).badge, '分析服务未运行');
  assert.equal(inspectorModel({ state: 'loading' }).badge, '加载中…');
  const model = inspectorModel({ state: 'result', result: { action: 'selected', humanDecided: true, rank: 2, groupSize: 3,
    score: .7, quality: null, focus: '清晰', flags: ['eyes-closed'], runName: '旅行', reasons: ['闭眼'], humanReason: '保留' } });
  assert.equal(model.badge, '精选 · 已人工决定'); assert.match(model.lines[0], /第 2 \/ 3 张.*质量 —/);
  assert.ok(model.lines.includes('闭眼')); assert.deepEqual(model.reasons, ['闭眼', '人工理由：保留']);
});
test('manifests use compact serviceMode and exact supported image/RAW inspector preview with matching versions', async () => {
  const main = JSON.parse(await readFile('src/plugin/manifest.json', 'utf8'));
  const inspector = JSON.parse(await readFile('src/inspector/manifest.json', 'utf8'));
  assert.equal(main.main.serviceMode, true); assert.equal(main.main.width, 420); assert.equal(main.main.height, 600);
    assert.equal(main.main.resizable, true);
  assert.equal(inspector.main, undefined); assert.notEqual(inspector.id, main.id);
  const metrics = await readFile('src/core/metrics.js', 'utf8');
  const supported = [...metrics.matchAll(/const (?:IMAGE|PROXY)_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/g)]
    .flatMap(match => [...match[1].matchAll(/"(\w+)"/g)].map(row => row[1])).sort();
  assert.deepEqual(Object.keys(inspector.preview).join(',').split(',').sort(), supported);
  const preview = Object.values(inspector.preview)[0].inspector;
  assert.equal(preview.path, 'index.html'); assert.equal(preview.multiSelect, true); assert.ok(preview.height >= 100);
  assert.equal(inspector.version, main.version); assert.equal(await checkUpdateVersion(), main.version);
  // The main plugin carries the same inspector so one import is enough; src/inspector stays as a separate fallback.
  const [mainKey, mainPreview] = Object.entries(main.preview)[0];
  assert.equal(mainKey, Object.keys(inspector.preview)[0]);
  assert.deepEqual(mainPreview.inspector, { ...preview, path: 'inspector/index.html' });
  const shared = await readFile('src/plugin/inspector/index.html', 'utf8');
  const fallback = await readFile('src/inspector/index.html', 'utf8');
  assert.equal(fallback.replaceAll('../plugin/inspector/', '').replace('../plugin/theme.css', '../theme.css'), shared);
});
test('version check rejects inspector divergence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'inspector-version-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src/plugin', 'src/inspector']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(root, 'src/plugin/manifest.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(root, 'src/inspector/manifest.json'), '{"version":"1.1.0"}');
  await assert.rejects(checkUpdateVersion(undefined, root), /检查器.*不一致/);
});

test('inspector selection refresh ignores stale responses and never writes Eagle', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const root = { hidden: false, querySelector: id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', children: [], hidden: false,
      replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } });
    return nodes.get(id);
  }, createElement: () => ({ textContent: '' }) };
  let selected = 'a', oldResolve, writes = 0;
  const eagle = { library: { path: '/fixture.library' }, item: { getSelected: async () => [{ id: selected }], save: () => writes++ } };
  const fetchImpl = async url => {
    if (url.includes('/a/')) return new Promise(resolve => { oldResolve = resolve; });
    return { ok: false, status: 404, json: async () => ({ error: '尚未分析' }) };
  };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    selected = 'b'; await view.refresh(true);
    assert.match(root.querySelector('#status').textContent, /尚未分析/);
    oldResolve({ ok: true, json: async () => ({ action: 'selected', groupSize: 1, runName: 'old', focus: '清晰' }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(root.querySelector('#status').textContent, /尚未分析/); assert.equal(writes, 0);
    view.setVisible(false); selected = 'c'; await view.refresh(true); assert.equal(writes, 0);
  } finally { view.dispose(); }
});
test('selecting from the panel asks Eagle to scroll the grid to the photo, without the internal channel it just selects', async () => {
  const { showInEagle, revealSelection } = await import('../src/plugin/eagle-select.js');
  const sent = [], selected = [];
  const ipc = { sendTo: (...args) => sent.push(args) };
  const eagle = { item: { select: async ids => selected.push(ids) } };
  assert.equal(await showInEagle(eagle, ['a'], undefined, () => revealSelection(ipc, 2)), 'selected');
  assert.deepEqual(selected, [['a']]);
  assert.deepEqual(sent, [[2, 'rebind-refresh']]);
  assert.equal(revealSelection(ipc, undefined), false);
  assert.equal(revealSelection(undefined, 2), false);
  assert.equal(await showInEagle(eagle, ['b']), 'selected');
});

test('personalization explains readiness, heldout agreement and the strongest factors in Chinese', async () => {
  const { personalizationModel } = await import('../src/plugin/inspector/inspector.js');
  const insufficient = personalizationModel({ ready: false, labeledGroups: 2, reason: 'insufficient-data' });
  assert.equal(insufficient.disabled, true);
  assert.match(insufficient.hint, /更多.*留出样本/);
  const unstable = personalizationModel({ ready: false, reason: 'no-stable-heldout-improvement' });
  assert.match(unstable.hint, /尚未稳定优于默认/);
  const ready = personalizationModel({ ready: true, labeledGroups: 32, remainingGroups: 8,
    before: { top1: { rate: .63 } }, after: { top1: { rate: .71 } },
    weights: { sharpness: 2, eyes: -3, exposure: 1, quality: .5, aesthetic: 0 } });
  assert.equal(ready.summary, '按你的 32 个选优决定学习；留出一致率 71%，默认 63%');
  assert.equal(ready.factors, '最影响的因素：睁眼比例（负向）、清晰度（正向）、曝光（正向）');
  assert.equal(ready.disabled, false); assert.equal(ready.button, '应用到剩余 8 组');
  assert.equal(personalizationModel({ applied: { at: '2026-10-13', changedGroups: 7 } }).applied, '已调整 7 组');
});

test('inspector personalizes locally after two clicks, expires confirmation and refreshes suggestions on undo', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {}, replacements: 0,
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; this.replacements++; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element };
  const member = { unitId: 'u1', itemIds: ['p1'], rank: 1, suggested: 'selected', flags: [] };
  const analysis = { runId: 'run-p', unitId: 'u1', groupId: 'g1', groupSize: 1, groupMembers: [member], focus: '清晰' };
  let report = { ready: false, labeledGroups: 2, remainingGroups: 8, reason: 'insufficient-data', applied: null };
  let failure = 0, analysisReads = 0, queueReads = 0;
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts.push(url.split('/personalize/')[1]);
      if (!failure) report = { ...report, applied: url.endsWith('/undo') ? null : { at: '2026-10-13', changedGroups: 7 } };
      return { ok: !failure, status: failure || 200, json: async () => ({}) };
    }
    if (url.endsWith('/personalize')) return { ok: true, json: async () => report };
    if (url.includes('/queue')) { queueReads++; return { ok: true, json: async () => ({ queue: [] }) }; }
    analysisReads++; return { ok: true, json: async () => analysis };
  };
  const eagle = { library: { path: '/fixture.library' }, item: { getSelected: async () => [{ id: 'p1' }] } };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl, session: null });
  const node = id => root.querySelector(`#${id}`);
  try {
    view.watcher.stop(); await view.refresh(true); await new Promise(resolve => setTimeout(resolve, 10));
    await view.loadPersonalization();
    assert.equal(node('personalizeApply').disabled, true); assert.match(node('personalizeHint').textContent, /更多/);
    await view.personalize(); assert.equal(posts.length, 0);
    report = { ...report, ready: true, labeledGroups: 32, weights: { quality: 2, sharpness: 1 } };
    const before = node('compareTable').replacements;
    await view.loadPersonalization(true);
    assert.equal(node('compareTable').replacements, before);
    assert.equal(node('personalizeApply').disabled, false);
    await view.personalize(); assert.equal(node('personalizeApply').textContent, '确认应用');
    await new Promise(resolve => setTimeout(resolve, 3100));
    assert.equal(node('personalizeApply').textContent, '应用到剩余 8 组');
    assert.equal(posts.length, 0);
    assert.equal(node('compareTable').replacements, before);
    await view.personalize(); await view.personalize();
    assert.deepEqual(posts, ['apply']);
    assert.equal(node('personalizeApplied').textContent, '已调整 7 组 ·');
    assert.equal(node('personalizeUndo').hidden, false);
    const reads = analysisReads, queues = queueReads;
    await view.personalize('undo');
    assert.deepEqual(posts, ['apply', 'undo']);
    assert.equal(node('personalizeUndo').hidden, true);
    assert.ok(analysisReads > reads); assert.ok(queueReads > queues);
    failure = 409;
    await view.personalize(); await view.personalize();
    assert.match(node('personalizeError').textContent, /尚未稳定优于默认/);
    assert.equal(node('personalizeApply').disabled, false);
  } finally { view.dispose(); }
});
