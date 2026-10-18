import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinishPanel, finishModel } from '../src/plugin/finish-panel.js';

function rootFixture() {
  const nodes = new Map();
  const node = () => ({ hidden: false, disabled: false, checked: false, value: '', textContent: '', events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    removeAttribute(name) { delete this[name]; }, replaceChildren() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector() { return this.input ||= node(); } });
  return { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('finish counts include only human decisions and cover the whole task', () => {
  const model = finishModel({ run: { scope: { label: '旅行' } }, writebackAvailable: true }, { total: 6, queue: [
    { human: 'selected' }, { human: 'candidate' }, { human: 'rejected' },
    { suggested: 'selected' }, { human: null }, { human: 'clear' }
  ] }, 'http://localhost:43125', 'run-a');
  assert.equal(model.title, '旅行');
  assert.deepEqual(model.counts, { selected: 1, candidate: 1, rejected: 1 });
  assert.equal(model.decided, 3);
  assert.match(model.text, /已决定 3 \/ 6 张/);
  assert.equal(model.canRevert, true);
  assert.equal(model.csvUrl, 'http://localhost:43125/runs/run-a/report?format=csv');
  assert.equal(model.jsonUrl, 'http://localhost:43125/runs/run-a/report?format=json');
  assert.equal(finishModel({}, { items: [] }, '', 'run-b').canRevert, false);
});

test('record page moves only confirmed rejects to the trash and offers tag writeback only with AI tags on', async () => {
  const root = rootFixture(), q = id => root.querySelector(`#${id}`), calls = [], shown = [], values = new Map();
  let applied = false;
  const api = async (path, options = {}) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, body });
    if (path.endsWith('/queue?mode=all')) return { total: 2, queue: [{ human: 'selected' }, { human: 'rejected' }] };
    if (path.includes('/results?')) return { run: { scope: { label: '照片' } }, writebackAvailable: applied };
    if (path.endsWith('/trash-rejected')) {
      return body.apply ? { trash: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }
        : { units: 1, count: 2, skipped: 0, files: ['IMG_1.jpg', 'IMG_1.cr3'] };
    }
    if (path.endsWith('/apply')) {
      if (body.apply) applied = true;
      return { summary: { changed: 2, unchanged: 0, tags: {}, byAction: {} }, results: [] };
    }
    if (path.endsWith('/writeback/revert')) { applied = false; return { results: [], summary: { unchanged: 2 } }; }
    assert.fail(path);
  };
  api.base = 'http://localhost:43125';
  const panel = createFinishPanel({ root, getApi: () => api, show: name => shown.push(name),
    storage: { getItem: key => values.get(key) ?? null } });
  await panel.open('run-a');
  assert.equal(shown.at(-1), 'finishPanel');
  assert.match(q('finishCounts').textContent, /已决定 2 \/ 2/);
  assert.equal(calls.filter(call => call.body).length, 0, 'opening the page must not write');
  assert.equal(q('tagWriteback').hidden, true, 'no tag section while AI tags are off and nothing was written');
  assert.equal(q('trashRejected').disabled, false);

  await q('trashRejected').events.click(); await tick();
  assert.deepEqual(calls.at(-1), { path: '/runs/run-a/trash-rejected', body: { apply: false } });
  assert.equal(q('trashDialog').open, true);
  assert.match(q('trashSummary').textContent, /标为淘汰的 1 张照片（共 2 个文件/);
  assert.equal(q('confirmTrash').disabled, true);
  await q('confirmTrash').events.click(); await tick();
  assert.equal(calls.filter(call => call.body?.apply).length, 0, 'nothing moves before MOVE_TO_TRASH is typed');
  q('trashConfirm').value = 'MOVE_TO_TRASH'; q('trashConfirm').events.input();
  assert.equal(q('confirmTrash').disabled, false);
  await q('confirmTrash').events.click(); await tick();
  assert.deepEqual(calls.at(-1), { path: '/runs/run-a/trash-rejected', body: { apply: true, confirm: 'MOVE_TO_TRASH' } });
  assert.equal(q('trashDialog').open, false);
  assert.match(q('trashResult').textContent, /已移入 Eagle 回收站 2 个文件/);

  values.set('eagle-culling-ai-tags', '1'); await panel.refresh();
  assert.equal(q('tagWriteback').hidden, false); assert.equal(q('dryRun').hidden, false);
  await q('dryRun').events.click();
  assert.equal(q('writebackDialog').open, true);
  assert.deepEqual(calls.at(-1), { path: '/runs/run-a/apply', body: { apply: false } });
  await q('confirmWriteback').events.click(); await tick();
  assert.equal(applied, true);
  assert.deepEqual(calls.findLast(call => call.path.endsWith('/apply')).body, { apply: true });
  assert.equal(q('revertWriteback').hidden, false);
  values.delete('eagle-culling-ai-tags'); await panel.refresh();
  assert.equal(q('tagWriteback').hidden, false, 'written tags stay revertible after the setting is turned off');
  assert.equal(q('dryRun').hidden, true);
  await q('revertWriteback').events.click(); await tick();
  assert.equal(applied, false);
  assert.equal(calls.filter(call => call.path.endsWith('/writeback/revert')).length, 1);
  panel.close();
  assert.equal(shown.at(-1), 'historyView');
});

test('finish panel ignores a previous task response after switching tasks', async () => {
  const root = rootFixture(), q = id => root.querySelector(`#${id}`);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const api = async path => {
    if (path.includes('run-old')) await delayed;
    return path.includes('/results?') ? { run: { scope: { label: path.includes('run-old') ? '旧任务' : '新任务' } } }
      : { total: 0, queue: [] };
  };
  api.base = 'http://localhost:43125';
  const panel = createFinishPanel({ root, getApi: () => api, show() {} });
  const old = panel.open('run-old');
  await panel.open('run-new');
  release(); await old;
  assert.equal(q('finishTask').textContent, '新任务');
  assert.match(q('reportCsv').href, /run-new/);
  assert.equal(panel.isBusy(), false);
});