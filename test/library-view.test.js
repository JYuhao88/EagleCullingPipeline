import test from 'node:test';
import assert from 'node:assert/strict';
import { placeStatus, librarySummary, folderRows, initialExpanded, rowDetail } from '../src/plugin/library-model.js';
import { mountLibraryView } from '../src/plugin/library-view.js';
import { inspectorModel, queueLine } from '../src/plugin/inspector/inspector.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const folder = (id, name, count, analyzed, children = [], extra = {}) => ({ id, name, count, analyzed, queued: null,
  running: null, children, subtree: { count: count + children.reduce((sum, child) => sum + child.subtree.count, 0),
    analyzed: analyzed + children.reduce((sum, child) => sum + child.subtree.analyzed, 0) }, ...extra });

function overview() {
  const good = folder('F2', 'good', 1, 0, [], { queued: 1 });
  return { libraryPath: '/x.library', total: 6, analyzed: 2, folders: [folder('F1', '汕头', 2, 2, [good]),
    folder('F3', '空的', 0, 0)], unfiled: { count: 3, analyzed: 0, queued: null, running: null },
  queue: [{ id: 'q1', label: '汕头 › good', type: 'folder', folderId: 'F2', position: 1 }], active: null };
}

test('places read as done, partial, not analyzed, queued or running', () => {
  assert.equal(placeStatus({ count: 3, analyzed: 3 }).chip, '✓ 已分析');
  assert.equal(placeStatus({ count: 3, analyzed: 1 }).chip, '◐ 已分析 1/3');
  assert.equal(placeStatus({ count: 3, analyzed: 0 }).chip, '○ 未分析');
  assert.equal(placeStatus({ count: 3, analyzed: 0, queued: 2 }).chip, '排队第 2');
  assert.equal(placeStatus({ count: 3, analyzed: 0, queued: 2, running: 54.7 }).chip, '分析中 54%');
  assert.equal(placeStatus({ count: 0 }).state, 'empty');
  assert.equal(librarySummary(overview()), '资源库 6 张 · 已分析 2 · 未分析 4 · 排队 1 个');
});

test('the folder tree mirrors Eagle, hides empty folders and lists photos in no folder last', () => {
  const data = overview(), expanded = initialExpanded(data);
  assert.deepEqual([...expanded], ['F1', 'F2']);
  const rows = folderRows(data, expanded);
  assert.deepEqual(rows.map(row => [row.name, row.depth]), [['汕头', 0], ['good', 1], ['未归入文件夹', 0]]);
  assert.equal(folderRows(data, new Set()).length, 2, 'collapsed folders hide their children');
  assert.equal(rowDetail(rows[0]), '2 张 · 含子文件夹 3 张，已分析 2');
  assert.equal(initialExpanded(data, 1).size, 1, 'large trees open only the top level');
});

function fakeRoot() {
  const elements = new Map();
  const node = () => ({ hidden: false, textContent: '', disabled: false, events: {}, children: [], dataset: {},
    addEventListener(name, callback) { this.events[name] = callback; }, setAttribute(name, value) { this[name] = value; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  return { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, node());
    return elements.get(selector);
  }, createElement: node };
}
const $ = (root, id) => root.querySelector(`#${id}`);
const find = (node, label) => {
  if (node.textContent === label && node.events?.click) return node;
  for (const child of node.children || []) { const hit = find(child, label); if (hit) return hit; }
  return null;
};

test('the library page queues folders, reorders and cancels the queue, and polls only while visible', async () => {
  const root = fakeRoot(), calls = [], timers = [], changes = [];
  const api = async (url, options = {}) => {
    calls.push([options.method || 'GET', url, options.body ? JSON.parse(options.body) : null]);
    if (url.startsWith('/library/overview')) return overview();
    if (url === '/queue') return { added: 1, started: null, queue: [{}, {}] };
    return {};
  };
  const view = mountLibraryView({ root, getApi: () => api, getLibraryPath: () => '/x.library', performanceMode: () => 'turbo',
    onChange: response => changes.push(response), setTimer: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimer() {} });
  await view.refresh();
  assert.equal(timers.length, 0, 'no polling while hidden');
  view.setVisible(true); await tick();
  assert.equal(timers.at(-1), 3000, 'a queue means faster polling');
  assert.equal($(root, 'librarySummary').textContent, '资源库 6 张 · 已分析 2 · 未分析 4 · 排队 1 个');
  const tree = $(root, 'libraryTree');
  assert.deepEqual(tree.children.map(row => row.dataset.state), ['done', 'queued', 'none']);
  assert.equal(find(tree.children[0], '排队'), null, 'an analyzed folder offers no 排队');
  find(tree.children[2], '排队').events.click(); await tick();
  assert.deepEqual(calls.find(call => call[1] === '/queue')[2],
    { libraryPath: '/x.library', scopes: [{ type: 'unfiled' }], performanceMode: 'turbo' });
  assert.equal(changes.length, 1); assert.equal($(root, 'libraryNotice').textContent, '已排队，轮到时自动开始。');
  find(tree.children[1], '取消排队').events.click(); await tick();
  assert.deepEqual(calls.find(call => call[1] === '/queue/q1').slice(0, 1), ['DELETE']);
  assert.equal($(root, 'clearQueue').hidden, false); assert.equal($(root, 'queueAllUnanalyzed').hidden, false);
  $(root, 'queueAllUnanalyzed').events.click(); await tick();
  assert.equal(calls.filter(call => call[1] === '/queue').at(-1)[2].allUnanalyzed, true);
  view.setVisible(false); view.dispose();
});

test('the inspector says where an unanalyzed photo waits in the queue', () => {
  assert.equal(queueLine({ position: 2, label: '汕头' }), '排队第 2：「汕头」');
  assert.equal(queueLine({ analyzing: true, label: '汕头', percent: 54.2 }), '正在分析「汕头」 54%');
  const waiting = inspectorModel({ state: 'empty', result: { queued: { position: 2, label: '汕头' } } });
  assert.equal(waiting.badge, '尚未分析'); assert.equal(waiting.lines[0], '排队第 2：「汕头」');
  const decided = inspectorModel({ state: 'empty', result: { pending: { action: 'selected' }, queued: { position: 1, label: 'A' } } });
  assert.match(decided.badge, /已记下/); assert.equal(decided.lines[0], '排队第 1：「A」');
  assert.equal(inspectorModel({ state: 'empty', result: {} }).badge, '尚未分析，在插件里按文件夹排队');
});
