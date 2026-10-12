import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartView } from '../src/plugin/start-view.js';
import { taskState, taskView, sortTasks, homeCard, measuredRate, libraryConfirmText, friendlyFailure } from '../src/plugin/task-model.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function fakeRoot() {
  const elements = new Map();
  const node = () => ({ value: '', hidden: false, textContent: '', events: {}, children: [], dataset: {}, checked: false,
    addEventListener(name, callback) { this.events[name] = callback; },
    removeAttribute(name) { delete this[name]; }, setAttribute(name, value) { this[name] = value; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  return { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, node());
    return elements.get(selector);
  }, createElement: node, addEventListener() {} };
}
const $ = (root, id) => root.querySelector(`#${id}`);
const rowAction = row => row.children.at(-1);
const rowDetail = row => row.children[0].children[2].textContent;
function withGlobals({ storage = new Map(), eagle } = {}, fn) {
  const previous = { localStorage: globalThis.localStorage, eagle: globalThis.eagle };
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key) };
  if (eagle) globalThis.eagle = eagle; else delete globalThis.eagle;
  return Promise.resolve().then(fn).finally(() => {
    globalThis.localStorage = previous.localStorage;
    if (previous.eagle) globalThis.eagle = previous.eagle; else delete globalThis.eagle;
  });
}

test('task states cover the lifecycle and give exactly one primary action', () => {
  const cases = [
    [{ status: 'running' }, 'analyzing', 'watch'],
    [{ status: 'interrupted' }, 'interrupted', 'resume'],
    [{ status: 'cancelled' }, 'cancelled', 'resume'],
    [{ status: 'failed', error: 'EPERM rename' }, 'failed', 'resume'],
    [{ status: 'interrupted', resumable: false, rerunnable: true }, 'lost', 'rerun'],
    [{ status: 'failed', resumable: false, rerunnable: false }, 'lost', 'reselect'],
    [{ status: 'completed', groupCount: 4, reviewedGroupCount: 1 }, 'reviewing', 'review'],
    [{ status: 'completed', groupCount: 4, reviewedGroupCount: 4 }, 'toWriteback', 'finish'],
    [{ status: 'completed', groupCount: 4, reviewedGroupCount: 4, writtenBackAt: '2026-10-13T11:00:00Z' }, 'writtenBack', 'review'],
    [{ status: 'completed', groupCount: 4, reviewedGroupCount: 4, writtenBackAt: 'x', pendingWriteback: true },
      'pendingWriteback', 'finish'],
    [{ status: 'completed', groupCount: 0 }, 'empty', 'review'],
  ];
  for (const [run, state, action] of cases) {
    assert.equal(taskState(run), state, JSON.stringify(run));
    assert.equal(taskView(run, NOW).primary.action, action, state);
  }
  assert.match(taskView({ status: 'failed', error: 'EPERM rename' }).detail, /占用/);
  assert.match(friendlyFailure('ENOSPC'), /磁盘空间/);
  const view = taskView({ status: 'completed', groupCount: 5, reviewedGroupCount: 2, inheritedCount: 7, scope: { label: '婚礼' } }, NOW);
  assert.equal(view.chip, '待挑选 2/5'); assert.match(view.detail, /还剩 3 组.*7 张沿用之前的决定/); assert.equal(view.title, '婚礼');
});

test('tasks sort by urgency then by recent activity', () => {
  const runs = [
    { id: 'done', status: 'completed', groupCount: 1, reviewedGroupCount: 1, writtenBackAt: 'x' },
    { id: 'old-review', status: 'completed', groupCount: 3, reviewedGroupCount: 1, lastDecisionAt: '2026-10-01T00:00:00Z' },
    { id: 'new-review', status: 'completed', groupCount: 3, reviewedGroupCount: 1, lastDecisionAt: '2026-10-12T00:00:00Z' },
    { id: 'broken', status: 'interrupted' },
  ];
  assert.deepEqual(sortTasks(runs).map(run => run.id), ['new-review', 'old-review', 'broken', 'done']);
});

test('home card is decided by service, activity, Eagle selection and unfinished work', () => {
  assert.equal(homeCard({ connected: false }).action.action, 'startService');
  assert.equal(homeCard({ connected: false, launching: true }).action, null);
  const active = homeCard({ connected: true, active: { status: 'running', scope: { label: 'A' }, progress: {} } });
  assert.equal(active.kind, 'progress'); assert.equal(active.secondary[0].action, 'cancel');
  const fresh = homeCard({ connected: true, context: { selectionCount: 40 }, secondsPerPhoto: 1.5 });
  assert.equal(fresh.kind, 'new'); assert.equal(fresh.action.label, '分析这 40 张'); assert.match(fresh.detail, /预计约 1 分 0 秒/);
  const task = { id: 't', status: 'completed', groupCount: 3, reviewedGroupCount: 1, scope: { label: '旅行' } };
  const covered = homeCard({ connected: true, context: { selectionCount: 10 }, match: { run: task, missing: 0, matched: 10 } });
  assert.equal(covered.kind, 'task'); assert.equal(covered.action.action, 'review'); assert.match(covered.title, /旅行/);
  const append = homeCard({ connected: true, context: { selectionCount: 12 },
    match: { run: task, missing: 2, matched: 10, sameScope: true } });
  assert.equal(append.kind, 'append'); assert.equal(append.action.label, '补充分析（新增 2 张）');
  assert.equal(append.secondary[0].action, 'openMatch');
  const resume = homeCard({ connected: true, tasks: [task] });
  assert.equal(resume.kind, 'task'); assert.equal(resume.eyebrow, '继续上次的任务');
  assert.equal(homeCard({ connected: true, tasks: [] }).kind, 'empty');
  assert.equal(homeCard({ connected: true, tasks: [] }).action, null, 'whole-library analysis is never the default');
});

test('measured rate ignores small and mostly cached runs; library confirmation states count and estimate', () => {
  const runs = [
    { status: 'completed', itemCount: 100, progress: { elapsedSeconds: 200 } },
    { status: 'completed', itemCount: 100, progress: { elapsedSeconds: 400 } },
    { status: 'completed', itemCount: 100, progress: { elapsedSeconds: 50, cached: 90 } },
    { status: 'completed', itemCount: 5, progress: { elapsedSeconds: 500 } },
  ];
  assert.equal(measuredRate(runs), 4);
  assert.equal(measuredRate([]), null);
  assert.match(libraryConfirmText(3000, 2), /3000 张.*约 1 小时 40 分/);
  assert.doesNotMatch(libraryConfirmText(null, null), /约/);
});

test('progress is shown in the primary card while analysing and completion waits for an explicit review', async () => {
  const storage = new Map(), notices = [];
  await withGlobals({ storage, eagle: { library: { path: '/fixture.library', name: '示例库' },
    notification: { show: async value => notices.push(value) } } }, async () => {
    const root = fakeRoot(); const opened = [];
    let run = { id: 'r1', libraryPath: '/fixture.library', status: 'running', scope: { label: '选中的 10 张' },
      progress: { stage: 'pose', completed: 4, total: 10, overallPercent: 60, elapsedSeconds: 120, remainingSeconds: 80 } };
    const api = async url => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: run.status === 'running' ? run : null };
      if (url.startsWith('/runs?')) return { runs: [run], page: { nextCursor: null } };
      if (url === '/runs/r1') return run;
      throw new Error(`unexpected ${url}`);
    };
    api.base = 'fixture';
    const view = createStartView({ root, api, onRun: async (...args) => opened.push(args), autoCheck: false, autoRefresh: false });
    try {
      await view.checkHealth();
      assert.equal($(root, 'primaryCard').dataset.kind, 'progress');
      assert.equal($(root, 'progress').hidden, false); assert.equal($(root, 'cancel').hidden, false);
      assert.equal($(root, 'bar').value, 60);
      assert.match($(root, 'progressText').textContent, /姿态分析 · 总体 60% · 已用 2 分 0 秒 · 预计剩余 1 分 20 秒/);
      assert.equal($(root, 'recentRuns').children.length, 0, 'the running task is shown only in the card');
      run = { ...run, status: 'completed', groupCount: 3, reviewedGroupCount: 0, selectedCount: 2 };
      await view.checkHealth();
      await tick(); await tick();
      assert.equal(opened.length, 0, 'never jumps into review by itself');
      assert.equal(notices.length, 1);
      assert.equal($(root, 'primaryCard').dataset.kind, 'task');
      assert.equal($(root, 'primaryAction').textContent, '开始挑选');
      await $(root, 'primaryAction').onclick();
      assert.deepEqual(opened, [['r1']]);
    } finally { view.dispose(); }
  });
});

test('selection analysis sends the selection or folder scope; whole library needs confirmation', async () => {
  let selected = [], folders = [{ id: 'f', name: '示例文件夹' }];
  const eagle = { library: { path: '/example.library', name: '示例' }, folder: { getSelected: async () => folders },
    item: { getSelected: async () => selected, countSelected: async () => selected.length, count: async () => 2,
      countAll: async () => 3, get: async () => [{ id: 'a' }, { id: 'b' }] } };
  await withGlobals({ eagle }, async () => {
    const root = fakeRoot(), calls = [], confirms = [];
    let allow = false;
    const api = async (url, options) => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      if (url.startsWith('/runs?')) return { runs: [], page: { nextCursor: null } };
      if (url === '/runs/match') return { match: null };
      if (url === '/runs') { calls.push(JSON.parse(options.body)); return { id: `run-${calls.length}` }; }
      return { id: url.split('/').pop(), status: 'completed', groupCount: 1, progress: { stage: 'done' } };
    };
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false,
      confirmImpl: text => { confirms.push(text); return allow; } });
    try {
      await view.checkHealth(); await view.refreshContext();
      assert.equal($(root, 'primaryAction').textContent, '分析这 2 张');
      assert.equal($(root, 'analyzeAll').hidden, true, 'library analysis is hidden while photos are selected');
      await $(root, 'primaryAction').onclick();
      assert.deepEqual(calls[0].itemIds, ['a', 'b']); assert.equal(calls[0].scope.type, 'folder');
      assert.equal(calls[0].scope.folderId, 'f'); assert.equal(calls[0].performanceMode, 'normal');
      selected = [{ id: 'c' }];
      await view.refreshContext();
      await $(root, 'primaryAction').onclick();
      assert.deepEqual(calls[1].itemIds, ['c']); assert.equal(calls[1].scope.type, 'selection');
      selected = []; folders = [];
      await view.refreshContext();
      assert.equal($(root, 'analyzeAll').hidden, false); assert.equal($(root, 'analyzeAll').textContent, '分析整个资源库（3 张）…');
      await $(root, 'analyzeAll').events.click(); await tick();
      assert.equal(calls.length, 2, 'declined confirmation starts nothing'); assert.match(confirms[0], /整个资源库 3 张/);
      allow = true;
      await $(root, 'analyzeAll').events.click(); await tick();
      assert.equal(calls[2].scope.type, 'library'); assert.equal(calls[2].itemIds, undefined);
    } finally { view.dispose(); }
  });
});

test('a selection already covered by a task offers that task instead of a new analysis', async () => {
  const eagle = { library: { path: '/example.library' }, folder: { getSelected: async () => [] },
    item: { getSelected: async () => [{ id: 'a' }, { id: 'b' }], countSelected: async () => 2, countAll: async () => 9 } };
  await withGlobals({ eagle }, async () => {
    const root = fakeRoot(), opened = [], posted = [];
    const task = { id: 'task-1', status: 'completed', groupCount: 2, reviewedGroupCount: 1, scope: { label: '旅行' } };
    let missing = 0;
    const api = async (url, options) => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      if (url.startsWith('/runs?')) return { runs: [task], page: { nextCursor: null } };
      if (url === '/runs/match') { posted.push(JSON.parse(options.body)); return { match: { runId: 'task-1', matched: 2 - missing,
        missing, sameScope: true } }; }
      throw new Error(`unexpected ${url}`);
    };
    const view = createStartView({ root, api, onRun: async id => opened.push(id), autoCheck: false, autoRefresh: false });
    try {
      await view.checkHealth(); await view.refreshContext(); await tick();
      assert.deepEqual(posted.at(-1).itemIds, ['a', 'b']);
      assert.equal($(root, 'primaryCard').dataset.kind, 'task');
      assert.equal($(root, 'primaryAction').textContent, '继续挑选');
      await $(root, 'primaryAction').onclick(); assert.deepEqual(opened, ['task-1']);
    } finally { view.dispose(); }
  });
});

test('broken tasks resume, rerun or explain how to reselect; a busy service is adopted', async () => {
  await withGlobals({}, async () => {
    const root = fakeRoot(), posted = [];
    const busyRun = { id: 'busy', status: 'running', progress: { stage: 'metrics', completed: 127, total: 3901 } };
    const runs = [{ id: 'paused', status: 'cancelled', progress: { overallPercent: 40 } },
      { id: 'lost', status: 'interrupted', resumable: false, rerunnable: true },
      { id: 'gone', status: 'failed', resumable: false, rerunnable: false, scope: { label: '旧文件夹' } }];
    let busy = false;
    const api = async (url, options) => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      if (url.startsWith('/runs?')) return { runs: busy ? [busyRun] : runs, page: { nextCursor: null } };
      if (url === '/runs') {
        posted.push(JSON.parse(options.body));
        if (posted.length === 2) { busy = true; throw Object.assign(new Error('busy'), { status: 409, body: { run: busyRun } }); }
        return { id: 'resumed', status: 'completed', groupCount: 1 };
      }
      if (url === '/runs/busy') return busyRun;
      if (url === '/runs/resumed') return { id: 'resumed', status: 'completed', groupCount: 1 };
      throw new Error(`unexpected ${url}`);
    };
    const view = createStartView({ root, api, onRun: () => assert.fail('unfinished run must not open'), autoCheck: false,
      autoRefresh: false });
    try {
      await view.checkHealth();
      const rows = () => $(root, 'recentRuns').children;
      const byId = id => rows().find(row => row.dataset.runId === id);
      assert.equal(rowAction(byId('paused')).textContent, '继续分析');
      assert.equal(rowAction(byId('lost')).textContent, '重新分析');
      assert.equal(rowAction(byId('gone')).textContent, '怎么做');
      await rowAction(byId('gone')).events.click({}); await tick();
      assert.match($(root, 'homeNotice').textContent, /重新选中「旧文件夹」/);
      await rowAction(byId('paused')).events.click({}); await tick();
      assert.deepEqual(posted[0], { resumeRunId: 'paused', performanceMode: 'normal' });
      await rowAction(byId('lost')).events.click({}); await tick();
      assert.deepEqual(posted[1], { rerunOf: 'lost', performanceMode: 'normal' });
      assert.match($(root, 'homeNotice').textContent, /已有分析在进行/);
      assert.match($(root, 'progressText').textContent, /^画质分析/);
      assert.equal($(root, 'primaryCard').dataset.kind, 'progress');
    } finally { view.dispose(); }
  });
});

test('offline home shows a service card and no review entry; retry connects', async () => {
  const repository = process.platform === 'win32' ? 'C:\\photo repo' : '/tmp/photo repo';
  await withGlobals({ storage: new Map([['eagle-culling-repository', repository]]) }, async () => {
    const root = fakeRoot(); let connected = false;
    const api = async url => {
      if (!connected) throw new Error('offline');
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      return { runs: [], page: { nextCursor: null } };
    };
    api.base = 'http://127.0.0.1:43210';
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
    try {
      await view.checkHealth();
      assert.equal($(root, 'primaryCard').dataset.kind, 'service');
      assert.equal($(root, 'primaryAction').textContent, '启动服务');
      assert.equal($(root, 'serviceGuide').hidden, false); assert.equal($(root, 'analyzeAll').hidden, true);
      assert.match($(root, 'serviceCommand').textContent, /--port 43210/);
      connected = true;
      await $(root, 'retryService').events.click();
      assert.equal($(root, 'serviceGuide').hidden, true);
      assert.equal($(root, 'primaryCard').dataset.kind, 'empty');
    } finally { view.dispose(); }
  });
});

test('home lists five tasks; history paginates and can include superseded versions', async () => {
  await withGlobals({}, async () => {
    const root = fakeRoot(), urls = []; let page = 0;
    const api = async url => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      urls.push(url);
      const first = !url.includes('cursor=6');
      return { runs: Array.from({ length: 6 }, (_, index) => ({ id: `run-${page}-${index}`, status: 'completed', groupCount: 1,
        reviewedGroupCount: 1, writtenBackAt: 'x' })), page: { nextCursor: first && page++ === 0 ? '6' : null } };
    };
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
    try {
      await view.checkHealth();
      assert.equal($(root, 'recentRuns').children.length, 5);
      assert.equal($(root, 'historyRuns').children.length, 6); assert.equal($(root, 'allRuns').hidden, false);
      await $(root, 'moreRuns').events.click(); await tick();
      assert.equal($(root, 'historyRuns').children.length, 12); assert.equal($(root, 'moreRuns').hidden, true);
      $(root, 'showSuperseded').checked = true; await $(root, 'showSuperseded').events.change(); await tick();
      assert.match(urls.at(-1), /includeSuperseded=1/);
    } finally { view.dispose(); }
  });
});

test('turbo preference persists and travels with analysis requests', async () => {
  const storage = new Map();
  const eagle = { library: { path: '/example.library' }, folder: { getSelected: async () => [] },
    item: { getSelected: async () => [{ id: 'a' }], countSelected: async () => 1, countAll: async () => 1 } };
  await withGlobals({ storage, eagle }, async () => {
    const calls = [];
    const api = async (url, options) => {
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      if (url.startsWith('/runs?')) return { runs: [], page: { nextCursor: null } };
      if (url === '/runs/match') return { match: null };
      if (url === '/runs') { calls.push(JSON.parse(options.body)); return { id: 'x' }; }
      return { id: 'x', status: 'completed', groupCount: 1 };
    };
    const root = fakeRoot();
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
    try {
      assert.equal($(root, 'performanceTurbo').checked, false);
      await view.checkHealth(); await view.refreshContext();
      await $(root, 'primaryAction').onclick(); assert.equal(calls[0].performanceMode, 'normal');
      const box = $(root, 'performanceTurbo'); box.checked = true; box.events.change();
      assert.equal(storage.get('eagle-culling-turbo'), '1');
      await $(root, 'primaryAction').onclick(); assert.equal(calls[1].performanceMode, 'turbo');
    } finally { view.dispose(); }
  });
});

test('library change clears the old tasks immediately and reloads for the new library', async () => {
  let libraryChanged;
  const eagle = { library: { path: '/old.library', name: '旧库' }, onLibraryChanged: callback => { libraryChanged = callback; },
    folder: { getSelected: async () => [] }, item: { countSelected: async () => 0, countAll: async () => 10 } };
  await withGlobals({ eagle }, async () => {
    const root = fakeRoot(), urls = [];
    const api = async url => {
      urls.push(url);
      if (url === '/health') return { service: 'eagle-culling' };
      if (url === '/runs/status') return { active: null };
      return { runs: url.includes('old.library') ? [{ id: 'old', status: 'completed', groupCount: 2, reviewedGroupCount: 0 }] : [],
        page: { nextCursor: null } };
    };
    const view = createStartView({ root, api, onRun() {}, autoCheck: false, autoRefresh: false });
    try {
      await view.refreshContext(); await view.checkHealth();
      assert.equal($(root, 'recentRuns').children.length, 1);
      eagle.library = { path: '/new.library', name: '新库' };
      libraryChanged('/new.library');
      assert.equal($(root, 'recentRuns').children.length, 0);
      assert.equal($(root, 'libraryName').textContent, 'new.library');
      await tick();
      assert.ok(urls.some(url => url.includes('libraryPath=%2Fnew.library')));
    } finally { view.dispose(); }
  });
});

test('changing the service address drops the old monitor and adopts the new service run', async () => {
  await withGlobals({}, async () => {
    const root = fakeRoot(), reads = [];
    function service(name) {
      const api = async url => {
        if (url === '/health') return { service: 'eagle-culling' };
        if (url.startsWith('/runs?')) return { runs: [], page: { nextCursor: null } };
        if (url === '/runs/status') return { active: { id: `run-${name}`, status: 'running' } };
        reads.push([name, url]); return { id: `run-${name}`, status: 'running', progress: { stage: 'metrics' } };
      };
      api.base = name; return api;
    }
    let api = service('old');
    const view = createStartView({ root, api, getApi: () => api, onRun() {}, autoCheck: false, autoRefresh: false });
    try {
      await view.checkHealth(); api = service('new'); await view.checkHealth();
      assert.deepEqual(reads, [['old', '/runs/run-old'], ['new', '/runs/run-new']]);
      assert.equal(view.view.active.id, 'run-new');
    } finally { view.dispose(); }
  });
});
