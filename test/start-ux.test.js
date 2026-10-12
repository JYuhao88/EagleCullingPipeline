import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAnalysis, stageIndex, readRecentRuns, analysisProgress, durationText } from '../src/plugin/start-model.js';
import { serviceLaunch, serviceCommand, defaultRepository } from '../src/plugin/service-start.js';
import { eagleContext } from '../src/plugin/api.js';
import { createStartView } from '../src/plugin/start-view.js';

test('primary analysis prioritizes selection, otherwise counts the folder and blocks empty context', () => {
  const context = { folders: [{ id: 'f' }], folderCount: 12, itemIds: ['a', 'b'] };
  assert.equal(primaryAnalysis(context).label, '分析选中的 2 张');
  assert.deepEqual(primaryAnalysis(context).itemIds, ['a', 'b']);
  assert.equal(primaryAnalysis({ ...context, itemIds: [] }).label, '分析当前文件夹（12 张）');
  assert.equal(primaryAnalysis({ ...context, itemIds: [] }).disabled, false);
  for (const value of [{}, { folders: [{}], folderCount: 0 }]) assert.equal(primaryAnalysis(value).disabled, true);
  assert.equal(primaryAnalysis(context, false).disabled, true);
  assert.equal(primaryAnalysis(context, true, true).disabled, true);
});

test('Windows launch uses node directly and PowerShell literal quoting; Unix retains nice', () => {
  const windows = serviceLaunch("C:\\Photo Repo's", 'http://localhost:43126', 'win32');
  assert.equal(windows.command, 'node');
  assert.deepEqual(windows.args, ['src/cli.js', 'serve', '--concurrency', '1', '--port', '43126']);
  assert.match(serviceCommand("C:\\Photo Repo's", 'http://localhost:43126', 'win32'), /Repo''s/);
  assert.doesNotMatch(serviceCommand('C:\\Repo', 'http://localhost:43126', 'win32'), /nice/);
  assert.equal(serviceLaunch('\\\\server\\share\\repo', 'http://localhost:43125', 'win32').command, 'node');
  assert.equal(serviceLaunch('//server/share/repo', 'http://localhost:43125', 'win32').command, 'node');
  assert.throws(() => serviceLaunch('C:relative', 'http://localhost', 'win32'), /绝对路径/);
  assert.equal(serviceLaunch('/tmp/example', 'http://localhost:43125', 'linux').command, 'nice');
  assert.deepEqual(serviceLaunch('/tmp/example', 'http://localhost:43125', 'darwin').args.slice(0, 3), ['-n', '15', 'node']);
  assert.equal(defaultRepository({ protocol: 'file:', pathname: '/C:/Repo/src/plugin/index.html' }), 'C:/Repo');
});

test('stage labels cover all analysis phases; malformed recent storage degrades safely', () => {
  assert.deepEqual(['scanning', 'pairing', 'metrics', 'embedding', 'faces', 'pose', 'focus', 'grouping', 'ranking', 'done']
    .map(stageIndex), [0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const value of ['{}', 'null', 'oops']) assert.deepEqual(readRecentRuns({ getItem: () => value }), []);
  assert.deepEqual(readRecentRuns({ getItem: () => '["run-ok","../bad",null]' }), ['run-ok']);
});

test('analysis progress displays measured overall estimates and distinct Chinese phases', () => {
  const run = { status: 'running', progress: { stage: 'focus', completed: 5, total: 10,
    overallPercent: 73.9, elapsedSeconds: 125, remainingSeconds: 65.1 } };
  const model = analysisProgress(run);
  assert.equal(model.overallPercent, 73.9);
  assert.equal(model.remainingSeconds, 66);
  assert.equal(model.text, '对焦分析 · 总体 73% · 已用 2 分 5 秒 · 预计剩余 1 分 6 秒');
  for (const [stage, label] of [['embedding', '特征提取'], ['pose', '姿态分析'], ['ranking', '排序']]) {
    assert.equal(analysisProgress({ ...run, progress: { ...run.progress, stage } }).stage, label);
  }
  assert.equal(durationText(3601), '1 小时 0 分');
  assert.equal(durationText(0), '0 秒');
});

test('old runs and insufficient warmup show estimating without inventing a percentage or ETA', () => {
  const startedAt = '2026-10-01T00:00:00Z', now = Date.parse(startedAt) + 90000;
  const legacy = { status: 'running', startedAt, progress: { stage: 'metrics', completed: 5, total: 10 } };
  const model = analysisProgress(legacy, now);
  assert.equal(model.overallPercent, null);
  assert.equal(model.remainingSeconds, null);
  assert.match(model.text, /总体进度待估算 · 已用 1 分 30 秒 · 预计剩余 估算中/);
  const warmup = analysisProgress({ ...legacy, progress: { ...legacy.progress, overallPercent: 12, remainingSeconds: null } });
  assert.match(warmup.text, /总体 12%/);
  assert.equal(warmup.remainingSeconds, null);
  assert.equal(analysisProgress({ status: 'completed', startedAt }, now).elapsedSeconds, null);
  assert.equal(analysisProgress({ status: 'completed', startedAt }, now).overallPercent, 100);
  assert.equal(analysisProgress({ status: 'interrupted', startedAt }, now).remainingSeconds, null);
});

test('invalid progress numbers degrade safely', () => {
  const model = analysisProgress({ status: 'running', progress: {
    overallPercent: NaN, elapsedSeconds: -1, remainingSeconds: Infinity
  } });
  assert.equal(model.overallPercent, null);
  assert.equal(model.elapsedSeconds, null);
  assert.equal(model.remainingSeconds, null);
  assert.match(model.text, /已用 未记录/);
});

test('Eagle context reads efficient counts and only loads folder items when starting analysis', async () => {
  const previous = globalThis.eagle;
  const queries = [];
  globalThis.eagle = {
    library: { path: '/example.library', name: '示例库' }, folder: { getSelected: async () => [{ id: 'f', name: '示例文件夹' }] },
    item: { getSelected: async () => [{ id: 'a' }], countAll: async () => 40,
      count: async query => { assert.deepEqual(query, { folders: ['f'] }); return 12; },
      get: async query => { queries.push(query); return [{ id: 'b' }]; } }
  };
  try {
    const context = await eagleContext();
    assert.equal(context.libraryCount, 40); assert.equal(context.folderCount, 12);
    assert.deepEqual(context.itemIds, ['a']); assert.deepEqual(queries, []);
    assert.deepEqual((await eagleContext({ selected: false })).itemIds, []);
    assert.deepEqual(queries, []);
    assert.deepEqual((await eagleContext({ includeFolderItems: true })).folderItemIds, ['b']);
    assert.deepEqual(queries, [{ folders: ['f'] }]);
  } finally { globalThis.eagle = previous; }
});

function fakeRoot() {
  const elements = new Map();
  const node = () => ({ value: '', hidden: false, textContent: '', events: {}, children: [],
    addEventListener(name, callback) { this.events[name] = callback; },
    removeAttribute(name) { delete this[name]; },
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
  return { querySelector(id) {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  }, createElement: node };
}

test('home recent and active cards show overall progress and measured timing, including warmup', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const root = fakeRoot();
  const run = { id: 'timed', status: 'running', progress: { stage: 'pose', completed: 4, total: 10,
    overallPercent: 60, elapsedSeconds: 120, remainingSeconds: 80 } };
  const api = async url => {
    if (url === '/health') return { service: 'eagle-culling' };
    if (url.startsWith('/runs?')) return { runs: [run], page: { nextCursor: null } };
    if (url === '/runs/status') return { active: run };
    return run;
  };
  const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
  try {
    await view.checkHealth();
    const text = '姿态分析 · 总体 60% · 已用 2 分 0 秒 · 预计剩余 1 分 20 秒';
    assert.ok(root.querySelector('#progressText').textContent.includes(text));
    assert.ok(root.querySelector('#recentRuns').children[0].children[1].textContent.includes(text));
    assert.equal(root.querySelector('#bar').max, 100);
    assert.equal(root.querySelector('#bar').value, 60);
    run.progress = { stage: 'focus', completed: 0, total: 10, overallPercent: 65, elapsedSeconds: 140, remainingSeconds: null };
    await root.querySelector('#recentRuns').children[0].children.at(-1).events.click();
    assert.match(root.querySelector('#progressText').textContent, /对焦分析 · 总体 65%/);
    assert.match(root.querySelector('#progressText').textContent, /预计剩余 估算中/);
    assert.equal(root.querySelector('#bar').value, 65);
    run.progress = { stage: 'metrics', completed: 4, total: 10 };
    await root.querySelector('#recentRuns').children[0].children.at(-1).events.click();
    assert.equal(root.querySelector('#bar').value, undefined);
  } finally { view.dispose(); globalThis.localStorage = previous; }
});

test('home welcome dismissal persists and help reopens it; recent run cards open or resume', async () => {
  const previous = globalThis.localStorage;
  const values = new Map([['eagle-culling-repository', '/tmp/example']]);
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
  const root = fakeRoot(), opened = [], posted = [];
  const api = async (url, options) => {
    if (url === '/health') return { service: 'eagle-culling' };
    if (url.startsWith('/runs?')) return { runs: [{ id: 'done', status: 'completed', groupCount: 2, reviewedGroupCount: 1 },
      { id: 'cancelled', status: 'cancelled' }], page: { nextCursor: null } };
    if (url === '/runs') { posted.push(JSON.parse(options.body)); return { id: 'resumed' }; }
    return { id: 'resumed', status: 'completed' };
  };
  try {
    const view = createStartView({ root, api, onRun: async id => opened.push(id), autoCheck: false, autoRefresh: false });
    assert.equal(root.querySelector('#welcome').hidden, false);
    root.querySelector('#closeWelcome').events.click();
    assert.equal(values.get('eagle-culling-welcome-dismissed'), '1');
    const next = fakeRoot();
    createStartView({ root: next, api, onRun() {}, autoCheck: false, autoRefresh: false });
    assert.equal(next.querySelector('#welcome').hidden, true);
    next.querySelector('#startHelp').events.click(); assert.equal(next.querySelector('#welcome').hidden, false);
    await view.checkHealth();
    const cards = root.querySelector('#recentRuns').children;
    assert.match(cards[0].children[1].textContent, /已审 1 \/ 2 组/);
    await cards[0].children.at(-1).events.click(); assert.deepEqual(opened, ['done']);
    await cards[1].children.at(-1).events.click(); assert.deepEqual(posted, [{ resumeRunId: 'cancelled' }]);
    assert.deepEqual(opened, ['done', 'resumed']); view.dispose();
  } finally { globalThis.localStorage = previous; }
});

test('primary folder analysis sends current folder IDs and selection overrides the folder scope', async () => {
  const previousEagle = globalThis.eagle, previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let selected = [], selectedFolders = [{ id: 'f', name: '示例文件夹' }];
  const calls = [];
  globalThis.eagle = { library: { path: '/example.library' }, folder: { getSelected: async () => selectedFolders },
    item: { getSelected: async () => selected, count: async () => 2, countAll: async () => 3,
      get: async () => [{ id: 'a' }, { id: 'b' }] } };
  const root = fakeRoot();
  const api = async (url, options) => {
    if (url === '/health') return { service: 'eagle-culling' };
    if (url.startsWith('/runs?')) return { runs: [], page: { nextCursor: null } };
    if (url === '/runs') { calls.push(JSON.parse(options.body)); return { id: 'example' }; }
    return { status: 'completed', progress: { stage: 'done' } };
  };
  try {
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
    await view.checkHealth(); await view.refreshContext();
    assert.equal(root.querySelector('#analyzeSelected').textContent, '分析当前文件夹（2 张）');
    await root.querySelector('#analyzeSelected').events.click();
    assert.deepEqual(calls[0].itemIds, ['a', 'b']); assert.equal(calls[0].scope.type, 'folder');
    selected = [{ id: 'c' }];
    await root.querySelector('#analyzeSelected').events.click();
    assert.deepEqual(calls[1].itemIds, ['c']); assert.equal(calls[1].scope.type, 'selection');
    selected = []; selectedFolders = [];
    await root.querySelector('#analyzeSelected').events.click();
    assert.equal(calls.length, 2); assert.equal(root.querySelector('#analyzeSelected').disabled, true);
    view.dispose();
  } finally { globalThis.eagle = previousEagle; globalThis.localStorage = previousStorage; }
});

test('new home recovers busy progress and gives safe failed or interrupted recent actions', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const root = fakeRoot(); let busy = false, reads = 0;
  const run = { id: 'run-busy', status: 'running', progress: { stage: 'metrics', completed: 127, total: 3901 } };
  const api = async (url, options) => {
    if (url === '/health') return { service: 'eagle-culling' };
    if (url.startsWith('/runs?')) return { runs: [busy ? run : { id: 'run-failed', status: 'failed', error: 'EPERM rename' },
      { id: 'run-old', status: 'interrupted' }], page: { nextCursor: null } };
    if (url === '/runs/status') return { active: null, recent: [] };
    if (url === '/runs') {
      assert.equal(JSON.parse(options.body).resumeRunId, 'run-failed'); busy = true;
      throw Object.assign(new Error('busy'), { status: 409, body: { run } });
    }
    if (url === '/runs/run-busy') { reads++; return run; }
    throw new Error('No full results reads allowed');
  };
  const view = createStartView({ root, api, onRun: () => assert.fail('unfinished run'), autoCheck: false, autoRefresh: false });
  try {
    await view.checkHealth();
    const cards = root.querySelector('#recentRuns').children;
    assert.match(cards[0].children[2].textContent, /无法保存文件/);
    assert.equal(cards[1].children.at(-1).textContent, '重新分析');
    await cards[0].children.at(-1).events.click();
    assert.match(root.querySelector('#health').textContent, /已有分析在进行/);
    assert.match(root.querySelector('#recentRuns').children[0].children[1].textContent, /127\/3901/);
    assert.equal(root.querySelector('#analyzeSelected').disabled, true);
    assert.equal(reads, 1);
  } finally { view.dispose(); globalThis.localStorage = previous; }
});
