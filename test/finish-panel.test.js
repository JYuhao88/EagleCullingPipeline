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

test('home finish flow previews, requires trash typing, applies and reverts the selected task', async () => {
  const root = rootFixture(), q = id => root.querySelector(`#${id}`), calls = [], shown = [];
  let applied = false;
  const api = async (path, options = {}) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, body });
    if (path.endsWith('/queue?mode=all')) return { total: 2, queue: [{ human: 'selected' }, { human: 'rejected' }] };
    if (path.includes('/results?')) return { run: { scope: { label: '照片' } }, writebackAvailable: applied };
    if (path.endsWith('/apply')) {
      if (body.apply) applied = true;
      return { summary: { changed: 2, unchanged: 0, tags: {}, byAction: {} }, results: [] };
    }
    if (path.endsWith('/writeback/revert')) { applied = false; return { results: [], summary: { unchanged: 2 } }; }
    assert.fail(path);
  };
  api.base = 'http://localhost:43125';
  const panel = createFinishPanel({ root, getApi: () => api, show: name => shown.push(name) });
  await panel.open('run-a');
  assert.equal(shown.at(-1), 'finishPanel');
  assert.match(q('finishCounts').textContent, /已决定 2 \/ 2/);
  assert.equal(calls.filter(call => call.body).length, 0, 'opening the panel must not write');
  await q('dryRun').events.click();
  assert.equal(q('writebackDialog').open, true);
  assert.deepEqual(calls.at(-1), { path: '/runs/run-a/apply', body: { apply: false } });
  q('moveTrash').checked = true;
  q('moveTrash').events.change();
  assert.equal(q('trashConfirm').hidden, false);
  await q('confirmWriteback').events.click();
  assert.equal(applied, false);
  assert.match(q('writeback').textContent, /MOVE_TO_TRASH/);
  q('trashConfirm').querySelector('input').value = 'MOVE_TO_TRASH';
  await q('confirmWriteback').events.click();
  await tick();
  assert.equal(applied, true);
  assert.equal(q('revertWriteback').hidden, false);
  assert.ok(calls.some(call => call.body?.apply && call.body.confirm === 'MOVE_TO_TRASH'));
  await q('revertWriteback').events.click();
  await tick();
  assert.equal(applied, false);
  assert.equal(q('revertWriteback').hidden, true);
  assert.equal(calls.filter(call => call.path.endsWith('/writeback/revert')).length, 1);
  panel.close();
  assert.equal(shown.at(-1), 'panelHome');
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