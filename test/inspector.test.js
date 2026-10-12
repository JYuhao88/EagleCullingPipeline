import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/server/run-store.js';
import { ItemAnalysisIndex, createItemAnalysisRouter } from '../src/server/item-analysis.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { inspectorModel } from '../src/inspector/inspector.js';
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
  assert.equal(preview.path, 'index.html'); assert.equal(preview.multiSelect, false); assert.ok(preview.height >= 100);
  assert.equal(inspector.version, main.version); assert.equal(await checkUpdateVersion(), main.version);
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
  const { mountInspector } = await import('../src/inspector/inspector.js');
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
