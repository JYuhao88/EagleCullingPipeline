import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { createWideRouter } from '../src/server/wide-routes.js';
import { createWideWatcher, enterWide, isResident, isWide, mainUrl, setResident, takeFill, wideUrl }
  from '../src/plugin/wide-mode.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
function fakeDom(extra = {}) {
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {}, style: {}, listeners: {},
    classList: { names: new Set(), add(name) { this.names.add(name); }, toggle() {} },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    addEventListener(type, handler) { this.listeners[type] = handler; } });
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element, ...extra };
  return { root, node: id => root.querySelector(`#${id}`) };
}
const memory = (data = new Map()) => ({ data, getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) });

test('the service holds 宽屏查看 polls until the right panel posts and answers a restart at once', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wide-'));
  const service = createAnalysisServer({ port: 0, pipeline: {}, runStore: new RunStore(root) });
  await service.listen();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}/ui/wide`;
  const first = await (await fetch(base)).json();
  assert.equal(first.seq, 0); assert.equal(typeof first.boot, 'string');
  let answered = null;
  const held = fetch(`${base}?boot=${first.boot}&after=0`).then(response => response.json()).then(body => { answered = body; });
  await settle(); assert.equal(answered, null);
  const posted = await (await fetch(base, { method: 'POST' })).json();
  await held;
  assert.deepEqual(posted, { boot: first.boot, seq: 1 }); assert.deepEqual(answered, posted);
  assert.deepEqual(await (await fetch(`${base}?boot=old&after=5`)).json(), posted);
  assert.equal((await fetch(base, { method: 'PUT' })).status, 405);
});

test('a held poll times out with the unchanged state and a dropped poll leaves no waiter behind', async t => {
  const route = createWideRouter({ holdMs: 30 });
  const server = http.createServer((req, res) => void route(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/ui/wide`;
  const { boot } = await (await fetch(base)).json();
  const aborted = new AbortController();
  const dropped = fetch(`${base}?boot=${boot}&after=0`, { signal: aborted.signal }).catch(() => null);
  await settle(); aborted.abort(); await dropped;
  const started = Date.now();
  assert.deepEqual(await (await fetch(`${base}?boot=${boot}&after=0`)).json(), { boot, seq: 0 });
  assert.ok(Date.now() - started >= 25);
});

test('the watcher takes the first answer as baseline, opens on a new request or after a restart, and never spins', async () => {
  const answers = [{ boot: 'a', seq: 3 }, { boot: 'a', seq: 4 }, { boot: 'b', seq: 0 }, { boot: 'c', seq: 1 }, { boot: 'c', seq: 1 }];
  const urls = [];
  let opened = 0, clock = 0;
  const watcher = createWideWatcher({ getBase: () => 'http://svc', onRequest: async () => { opened++; }, now: () => clock,
    fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => answers.shift() }; } });
  assert.equal(await watcher.once(), true); assert.equal(opened, 0);
  assert.equal(await watcher.once(), true); assert.equal(opened, 1);
  assert.equal(await watcher.once(), true); assert.equal(opened, 1);
  assert.equal(await watcher.once(), true); assert.equal(opened, 2);
  assert.equal(await watcher.once(), false, 'an unchanged answer that came back at once backs off');
  assert.deepEqual(urls, ['http://svc/ui/wide', 'http://svc/ui/wide?boot=a&after=3', 'http://svc/ui/wide?boot=a&after=4',
    'http://svc/ui/wide?boot=b&after=0', 'http://svc/ui/wide?boot=c&after=1']);
  answers.push({ boot: 'c', seq: 1 });
  const slow = createWideWatcher({ getBase: () => 'http://svc', onRequest: async () => {}, now: () => (clock += 1000),
    fetchImpl: async () => ({ ok: true, json: async () => ({ boot: 'c', seq: 1 }) }) });
  await slow.once();
  assert.equal(await slow.once(), true, 'a hold that timed out polls again at once');
  await assert.rejects(createWideWatcher({ getBase: () => 'http://svc', onRequest: async () => {},
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'not found' }) }) }).once());
});

test('the main page and the wide page switch by URL, keep Eagle theme and locale, and maximize only once', () => {
  assert.equal(wideUrl('?theme=DARK&locale=zh_CN'), 'inspector/index.html?theme=DARK&locale=zh_CN&mode=wide');
  assert.equal(mainUrl('?theme=DARK&locale=zh_CN&mode=wide'), '../index.html?theme=DARK&locale=zh_CN');
  assert.equal(mainUrl('?mode=wide&id=x'), '../index.html');
  assert.equal(isWide('eagleplugin://abc/inspector/index.html?theme=DARK&mode=wide'), true);
  assert.equal(isWide('file:///p/inspector/index.html?id=x'), false);
  const assigned = [], win = { sessionStorage: memory(), location: { search: '?theme=LIGHT', assign: url => assigned.push(url) } };
  enterWide(win);
  assert.deepEqual(assigned, ['inspector/index.html?theme=LIGHT&mode=wide']); assert.equal(win.__ecAllowUnload, true);
  assert.equal(takeFill(win), true); assert.equal(takeFill(win), false);
  assert.equal(isResident(win), false);
  setResident(true, win); assert.equal(isResident(win), true);
  setResident(false, win); assert.equal(isResident(win), false);
  assert.equal(isResident({}), false); assert.doesNotThrow(() => setResident(true, {}));
});

test('the wide inspector shows a single photo large, keeps no panel state, and goes back to the main page', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const { root, node } = fakeDom({ documentElement: { dataset: {}, style: {} },
    body: { style: {}, scrollHeight: 900, setAttribute() {} } });
  const result = { runId: 'run 1', unitId: 'u1', groupSize: 1, groupMembers: [
    { unitId: 'u1', itemIds: ['p1'], rank: 1, suggested: 'selected', flags: [], metrics: { score: .7 } }] };
  let polls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (!url.includes('/ui/wide')) return { ok: true, status: 200, json: async () => result };
    if (polls++ === 0) return { ok: true, json: async () => ({ boot: 'b', seq: 0 }) };
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const runs = [], hides = [], calls = [], session = memory(), tab = memory();
  const eagle = { library: { path: '/lib' }, onPluginRun: handler => runs.push(handler),
    onPluginHide: handler => hides.push(handler),
    item: { getSelected: async () => [{ id: 'p1', star: 0 }], getByIds: async () => [] },
    window: { unmaximize: async () => calls.push('unmaximize') } };
  const assigned = [];
  globalThis.location = { assign: url => assigned.push(url) };
  globalThis.window = { sessionStorage: tab };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null, setItem() {} }, fetchImpl, session,
    pageUrl: 'eagleplugin://abc/inspector/index.html?theme=DARK&locale=zh_CN&mode=wide' });
  try {
    await view.refresh(true); await settle();
    assert.equal(root.documentElement.dataset.mode, 'wide');
    const pair = node('pair');
    assert.equal(pair.hidden, false); assert.equal(pair.children.length, 1);
    const [preview, sharp] = pair.children[0].children;
    assert.match(preview.src, /\/runs\/run%201\/preview\/u1$/);
    assert.equal(sharp.className, 'sharp'); assert.match(sharp.src, /\/runs\/run%201\/display\/u1\?edge=2048$/);
    assert.equal(session.data.has('eagle-culling-inspector-height'), false);
    assert.equal(session.data.has('eagle-culling-inspector-snapshot'), false);
    assert.equal(polls, 2, 'the wide page waits for 宽屏查看 itself');
    assert.equal(runs.length, 0, 'an open from the plugin menu keeps the wide page');
    for (const hide of hides) hide();
    await settle();
    assert.deepEqual(calls, [], 'a hidden window keeps its size');
    assert.deepEqual(assigned, ['../index.html?theme=DARK&locale=zh_CN']); assert.equal(tab.data.get('eagle-culling-resident'), '1');
    node('wideBack').listeners.click(); await settle();
    assert.deepEqual(calls, ['unmaximize']); assert.equal(assigned[1], '../index.html?theme=DARK&locale=zh_CN');
    assert.equal(tab.data.has('eagle-culling-resident'), false);
  } finally { view.dispose(); delete globalThis.location; delete globalThis.window; }
});

test('the wide inspector says what to do when nothing is selected or the photo is not analyzed', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const { root, node } = fakeDom({ documentElement: { dataset: {}, style: {} },
    body: { style: {}, scrollHeight: 900, setAttribute() {} } });
  const fetchImpl = async (url, options = {}) => url.includes('/ui/wide')
    ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    : { ok: false, status: 404, json: async () => ({ error: 'not analyzed' }) };
  let selected = [];
  const eagle = { library: { path: '/lib' }, item: { getSelected: async () => selected, getByIds: async () => [] } };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null, setItem() {} }, fetchImpl, session: null,
    pageUrl: 'eagleplugin://abc/inspector/index.html?mode=wide' });
  try {
    await view.refresh(true);
    assert.equal(node('status').textContent, '在 Eagle 里选中照片后显示');
    selected = [{ id: 'p9', star: 0 }]; await view.refresh(true);
    assert.equal(node('status').textContent, '这张照片尚未分析：点「返回主界面」去分析');
  } finally { view.dispose(); }
});

test('宽屏查看 in the right panel asks the main window through the service and says what to do if nothing opens', async () => {
  const { mountInspector } = await import('../src/plugin/inspector/inspector.js');
  const { root, node } = fakeDom();
  const posts = [];
  let fail = false;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push(url); return { ok: !fail, status: fail ? 500 : 200, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const eagle = { library: { path: '/lib' }, item: { getSelected: async () => [] } };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, fetchImpl, session: null });
  try {
    view.watcher.stop();
    node('wideOpen').listeners.click(); await settle();
    assert.deepEqual(posts, ['http://127.0.0.1:43125/ui/wide']);
    assert.equal(node('actionStatus').textContent, '已请求在插件窗口打开宽屏检查器；没出现时，从插件菜单打开「Eagle照片筛选」。');
    fail = true; node('wideOpen').listeners.click(); await settle();
    assert.equal(node('actionStatus').textContent, '本地服务没有响应，没能打开宽屏检查器。');
  } finally { view.dispose(); }
});
