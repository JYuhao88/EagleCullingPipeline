import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SETTINGS, readSetting, writeSetting } from '../src/plugin/panel-settings.js';
import { shouldAutoStart, launchLocalService, createRunNotifier, mountBackgroundLifecycle } from '../src/plugin/background.js';
import { scopeLabel, primaryAnalysis } from '../src/plugin/start-model.js';
import { eagleContext } from '../src/plugin/api.js';
import { setWindowMode } from '../src/plugin/window-mode.js';
const fixtureRepository = process.platform === 'win32' ? 'C:\\fixture' : '/tmp/fixture';
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null,
  setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };

test('scope card and main button prioritize selection, folder, then entire library', () => {
  const context = { libraryPath: '/fixture.library', libraryCount: 40, selectionCount: 3, folders: [{ name: '旅行' }], folderCount: 12 };
  assert.equal(scopeLabel(context), '选中 3 张');
  assert.equal(primaryAnalysis(context).label, '分析选中的 3 张');
  const folder = { ...context, selectionCount: 0 };
  assert.equal(scopeLabel(folder), '文件夹 旅行（12 张）');
  assert.equal(primaryAnalysis(folder).disabled, false);
  const library = { ...folder, folders: [] };
  assert.equal(scopeLabel(library), '整个资源库（40 张）');
  assert.equal(primaryAnalysis(library).itemIds, null);
  for (const change of [{ libraryCount: 0 }, { libraryPath: '' }]) assert.equal(primaryAnalysis({ ...library, ...change }).disabled, true);
  assert.equal(primaryAnalysis(context, false).disabled, true);
  assert.equal(primaryAnalysis(context, true, true).disabled, true);
});
test('lightweight scope uses countSelected without loading full selection IDs', async () => {
  const old = globalThis.eagle; let calls = 0;
  globalThis.eagle = { library: { path: '/fixture.library' }, item: {
    countSelected: async () => 5000, getSelected: async () => { calls++; return [{ id: 'a' }]; }, countAll: async () => 6000 } };
  try {
    assert.equal((await eagleContext({ lightweight: true })).selectionCount, 5000); assert.equal(calls, 0);
    assert.deepEqual((await eagleContext()).itemIds, ['a']); assert.equal(calls, 1);
  } finally { globalThis.eagle = old; }
});
test('settings exact keys and defaults persist without enabling writeback implicitly', () => {
  const values = storage();
  for (const [id, [, defaultValue]] of Object.entries(SETTINGS)) {
    assert.equal(readSetting(values, id), defaultValue);
    writeSetting(values, id, !defaultValue); assert.equal(readSetting(values, id), !defaultValue);
    writeSetting(values, id, defaultValue); assert.equal(readSetting(values, id), defaultValue);
  }
  assert.equal(values.getItem('eagle-culling-live-writeback'), '0');
  assert.equal(values.getItem('eagle-culling-live-star'), '0');
  assert.equal(values.getItem('eagle-culling-smart-folders'), '1');
});
test('auto start refuses running, disabled, non-local, missing repo and concurrent starts', () => {
  const input = { connected: false, enabled: true, repository: fixtureRepository, base: 'http://127.0.0.1:43441' };
  assert.equal(shouldAutoStart(input), true);
  for (const change of [{ connected: true }, { enabled: false }, { launching: true }, { repository: '' },
    { base: 'https://localhost:43441' }, { base: 'http://example.invalid:43441' }])
    assert.equal(shouldAutoStart({ ...input, ...change }), false);
});
test('launch CLI detaches, ignores stdio, unrefs and blocks occupied or newly disabled startup', async () => {
  let options, command, args, unref = false;
  const requireImpl = name => {
    assert.equal(name, 'node:child_process');
    return { spawn: (cmd, argv, opts) => { command = cmd; args = argv; options = opts;
      const child = new EventEmitter(); child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit('spawn')); return child; } };
  };
  const input = { repository: fixtureRepository, base: 'http://127.0.0.1:43441', requireImpl, occupied: async () => false };
  await launchLocalService(input);
  assert.equal(command, process.platform === 'win32' ? 'node' : 'nice');
  assert.ok(args.includes('src/cli.js')); assert.ok(args.includes('serve'));
  assert.deepEqual(options, { cwd: fixtureRepository, detached: true, stdio: 'ignore', windowsHide: true }); assert.equal(unref, true);
  await assert.rejects(launchLocalService({ ...input, occupied: async () => true }), /占用/);
  await assert.rejects(launchLocalService({ ...input, allowed: () => false }), /关闭/);
});
test('completion and failure notify once across fresh notifier instances and skip missing API', async () => {
  const values = storage(), calls = [], eagle = { notification: { show: async row => calls.push(row) } };
  const input = { storage: values, eagle, base: () => 'fixture' };
  const run = { id: 'run-complete', status: 'completed', groupCount: 12, selectedCount: 8, rejectedCount: 3 };
  const notify = createRunNotifier(input);
  assert.equal(await notify({ ...run, status: 'running' }), false);
  assert.equal(await notify(run), true); assert.match(calls[0].body, /12 组.*精选 8 张/);
  assert.equal(await createRunNotifier(input)(run), false);
  assert.equal(await notify({ id: 'run-failed', status: 'failed', error: 'fixture failure' }), true);
  assert.equal(calls.length, 2); assert.equal(calls[1].title, '照片分析失败');
  assert.equal(await createRunNotifier({ ...input, eagle: {} })({ ...run, id: 'unavailable' }), false);
});
test('background lifecycle hides on close, shows on run, and permits updater reload', async () => {
  const hooks = {}, visibility = [], win = {}; let shown = 0, hidden = 0, created = 0;
  const eagle = { window: { show: async () => shown++, hide: async () => hidden++ } };
  for (const event of ['Create', 'Run', 'Show', 'Hide']) eagle[`onPlugin${event}`] = cb => { hooks[event] = cb; };
  mountBackgroundLifecycle({ eagle, win, onVisible: value => visibility.push(value), onCreate: async () => created++ });
  hooks.Create(); hooks.Run(); hooks.Hide(); hooks.Show();
  assert.equal(shown, 1); assert.equal(created, 1); assert.deepEqual(visibility, [false, true, false, true]);
  assert.equal(win.onbeforeunload({}), false); assert.equal(hidden, 1);
  win.__ecAllowUnload = true; assert.equal(win.onbeforeunload({}), undefined);
});
test('window mode maximizes review and returns to compact size; missing APIs are harmless', async () => {
  const calls = [];
  await setWindowMode(true, { window: { maximize: async () => calls.push('max') } });
  await setWindowMode(false, { window: { unmaximize: async () => calls.push('restore'), setSize: async (...args) => calls.push(args) } });
  assert.deepEqual(calls, ['max', 'restore', [420, 600]]);
  await setWindowMode(true, {});
  await setWindowMode(true, { window: { setSize: async (w, h) => { assert.equal(w, 1000); assert.equal(h, 700); } },
    screen: { getPrimaryDisplay: async () => ({ workAreaSize: { width: 1000, height: 700 } }) } });
});

test('Windows launch uses direct Node and BelowNormal without a visible console', async () => {
  const calls = [], priority = [];
  const child = new EventEmitter(); child.pid = 42; child.unref = () => calls.push('unref');
  const requireImpl = name => name === 'node:os' ? { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority:
    (...args) => priority.push(args) }
    : { spawn: (command, args, options) => { calls.push({ command, args, options }); queueMicrotask(() => child.emit('spawn'));
      return child; } };
  await launchLocalService({ repository: 'C:/fixture', base: 'http://localhost:43441', requireImpl, occupied: async () => false });
  assert.equal(calls[0].command, 'node'); assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(priority, [[42, 10]]); assert.equal(calls[1], 'unref');
});
