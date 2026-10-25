import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SETTINGS, readSetting, writeSetting } from '../src/plugin/panel-settings.js';
import { shouldAutoStart, launchLocalService, launchEnv, createRunNotifier, mountBackgroundLifecycle, RELOAD_KEY }
  from '../src/plugin/background.js';
import { createWindowSizer, readSavedSize } from '../src/plugin/window-mode.js';
const fixtureRepository = process.platform === 'win32' ? 'C:\\fixture' : '/tmp/fixture';
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null,
  setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };

test('settings exact keys and defaults persist without enabling writeback implicitly', () => {
  const values = storage();
  for (const [id, [, defaultValue]] of Object.entries(SETTINGS)) {
    assert.equal(readSetting(values, id), defaultValue);
    writeSetting(values, id, !defaultValue); assert.equal(readSetting(values, id), !defaultValue);
    writeSetting(values, id, defaultValue); assert.equal(readSetting(values, id), defaultValue);
  }
  assert.equal(values.getItem('eagle-culling-live-writeback'), '0');
  assert.equal(values.getItem('eagle-culling-ai-tags'), '0', 'AI tags are opt-in');
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
  const input = { repository: fixtureRepository, base: 'http://127.0.0.1:43441', requireImpl, occupied: async () => false,
    env: { PATH: '/usr/bin:/bin' }, earlyExitMs: 5 };
  await launchLocalService(input);
  assert.equal(command, process.platform === 'win32' ? 'node' : 'nice');
  assert.ok(args.includes('src/cli.js')); assert.ok(args.includes('serve'));
  const { env, ...rest } = options;
  assert.deepEqual(rest, { cwd: fixtureRepository, detached: true, stdio: 'ignore', windowsHide: true }); assert.equal(unref, true);
  if (process.platform !== 'win32') assert.match(env.PATH, /^\/usr\/bin:\/bin:.*\/opt\/homebrew\/bin/);
  await assert.rejects(launchLocalService({ ...input, occupied: async () => true }), /占用/);
  await assert.rejects(launchLocalService({ ...input, allowed: () => false }), /关闭/);
});
test('launch reports a missing Node instead of waiting for a service that already exited', async () => {
  const requireImpl = () => ({ spawn: () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 127); }); return child; }, readdirSync: () => [] });
  const input = { repository: fixtureRepository, base: 'http://127.0.0.1:43441', requireImpl, occupied: async () => false };
  await assert.rejects(launchLocalService(input), /找不到 Node/);
});
test('Dock-launched apps get the usual Node install folders appended to PATH', () => {
  const env = launchEnv({ PATH: '/usr/bin:/bin', HOME: '/tmp/fixture-home' }, 'darwin', () => ['v20.1.0', 'v22.9.0']);
  const dirs = env.PATH.split(':');
  assert.deepEqual(dirs.slice(0, 2), ['/usr/bin', '/bin']);
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/tmp/fixture-home/.volta/bin']) assert.ok(dirs.includes(dir), dir);
  const nvm = version => dirs.indexOf(`/tmp/fixture-home/.nvm/versions/node/${version}/bin`);
  assert.ok(nvm('v22.9.0') < nvm('v20.1.0'));
  assert.deepEqual(launchEnv({ PATH: 'C:\\Windows' }, 'win32'), { PATH: 'C:\\Windows' });
});
test('completion and failure notify once across fresh notifier instances and skip missing API and prefetch runs', async () => {
  const values = storage(), calls = [], eagle = { notification: { show: async row => calls.push(row) } };
  const input = { storage: values, eagle, base: () => 'fixture' };
  const run = { id: 'run-complete', status: 'completed', groupCount: 12, selectedCount: 8, rejectedCount: 3 };
  const notify = createRunNotifier(input);
  assert.equal(await notify({ ...run, status: 'running' }), false);
  assert.equal(await notify(run), true); assert.match(calls[0].body, /12 组.*精选 8 张/);
  assert.equal(await createRunNotifier(input)(run), false);
  assert.equal(await notify({ id: 'run-failed', status: 'failed', error: 'fixture failure' }), true);
  assert.equal(calls.length, 2); assert.equal(calls[1].title, '照片分析失败');
  assert.equal(await notify({ id: 'run-p', status: 'completed', purpose: 'prefetch' }), false); assert.equal(calls.length, 2);
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
test('a page loaded into a hidden window stays hidden on its own plugin-run and hands menu opens to onOpen', () => {
  for (const [options, saved] of [[{ loadedHidden: true }, null], [{}, '0']]) {
    const hooks = {}, visibility = [], session = new Map(saved ? [[RELOAD_KEY, saved]] : []);
    let shown = 0, opened = 0;
    const eagle = { window: { show: async () => shown++ } };
    for (const event of ['Create', 'Run', 'Show', 'Hide']) eagle[`onPlugin${event}`] = cb => { hooks[event] = cb; };
    const win = { sessionStorage: { getItem: key => session.get(key) ?? null, removeItem: key => session.delete(key) } };
    mountBackgroundLifecycle({ eagle, win, ...options, onVisible: value => visibility.push(value), onCreate: async () => {},
      onOpen: () => opened++ });
    hooks.Create(); hooks.Run();
    assert.equal(shown, 0); assert.equal(opened, 0); assert.equal(visibility.at(-1), false);
    hooks.Run(); hooks.Run();
    assert.equal(shown, 2); assert.equal(opened, 2); assert.equal(visibility.at(-1), true);
  }
});
test('window sizer remembers the user size, zooms on request and restores the remembered size', async () => {
  const calls = [], store = new Map(), listeners = {};
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  let size = [700, 560];
  const eagle = { window: { getSize: async () => size, isMaximized: async () => false,
    maximize: async () => calls.push('max'), unmaximize: async () => calls.push('unmax'),
    setSize: async (w, h) => { calls.push([w, h]); size = [w, h]; } } };
  const button = { hidden: true, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const root = { querySelectorAll: () => [button], addEventListener: (type, fn) => { listeners[type] = fn; } };
  const win = { addEventListener: (type, fn) => { listeners[`win:${type}`] = fn; } };
  const sizer = createWindowSizer({ eagle, storage, root, win, delay: 0 });
  assert.equal(button.hidden, false); assert.equal(button.textContent, '放大窗口');
  assert.equal(await sizer.restore(), false);
  await sizer.toggle();
  assert.deepEqual(readSavedSize(storage), { width: 700, height: 560 });
  assert.equal(button.textContent, '还原窗口'); assert.deepEqual(calls, ['max']);
  await sizer.toggle();
  assert.deepEqual(calls, ['max', 'unmax', [700, 560]]);
  storage.setItem('eagle-culling-window-size', JSON.stringify({ width: 100, height: 100 }));
  assert.deepEqual(readSavedSize(storage), { width: 360, height: 480 });
  const bare = createWindowSizer({ eagle: {}, storage, root, win });
  assert.equal(bare.supported, false); assert.equal(await bare.toggle(), false); assert.equal(button.hidden, true);
});

test('Windows launch uses direct Node and BelowNormal without a visible console', async () => {
  const calls = [], priority = [];
  const child = new EventEmitter(); child.pid = 42; child.unref = () => calls.push('unref');
  const requireImpl = name => name === 'node:os' ? { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority:
    (...args) => priority.push(args) }
    : { spawn: (command, args, options) => { calls.push({ command, args, options }); queueMicrotask(() => child.emit('spawn'));
      return child; } };
  await launchLocalService({ repository: 'C:/fixture', base: 'http://localhost:43441', requireImpl, occupied: async () => false,
    earlyExitMs: 5 });
  assert.equal(calls[0].command, 'node'); assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(priority, [[42, 10]]); assert.equal(calls[1], 'unref');
});
