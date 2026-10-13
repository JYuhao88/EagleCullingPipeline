import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCodeReload } from '../src/plugin/code-reload.js';
import { mountBackgroundLifecycle, RELOAD_KEY } from '../src/plugin/background.js';
import { createPluginStamp } from '../src/server/plugin-stamp.js';

test('code reload keeps the first stamp as baseline and reloads once, only when idle', async () => {
  let stamp = 'a', idle = false, reloads = 0;
  const watcher = createCodeReload({ fetchStamp: async () => stamp, reload: () => reloads++, isIdle: () => idle });
  assert.equal(await watcher.tick(), false);
  assert.equal(await watcher.tick(), false);
  stamp = 'b';
  assert.equal(await watcher.tick(), false); assert.equal(reloads, 0);
  idle = true;
  assert.equal(await watcher.tick(), true); assert.equal(reloads, 1);
  const offline = createCodeReload({ fetchStamp: async () => { throw new Error('down'); }, reload: () => reloads++ });
  assert.equal(await offline.tick(), false);
  const missing = createCodeReload({ fetchStamp: async () => null, reload: () => reloads++ });
  await missing.tick(); await missing.tick(); assert.equal(reloads, 1);
});

test('a reloaded background page restores its visibility and reruns startup without Eagle events', () => {
  const session = new Map();
  const win = { sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value),
    removeItem: key => session.delete(key) }, location: { reload() { win.reloaded = true; } } };
  const handlers = {};
  const eagle = { onPluginShow: handler => { handlers.show = handler; }, onPluginCreate() {}, onPluginRun() {}, onPluginHide() {} };
  const seen = [];
  let creates = 0;
  const first = mountBackgroundLifecycle({ eagle, win, onVisible: value => seen.push(value), onCreate: () => creates++ });
  handlers.show();
  first.reload();
  assert.equal(session.get(RELOAD_KEY), '1'); assert.equal(win.__ecAllowUnload, true); assert.equal(win.reloaded, true);
  seen.length = 0;
  mountBackgroundLifecycle({ eagle, win, onVisible: value => seen.push(value), onCreate: () => creates++ });
  assert.deepEqual(seen, [true]); assert.equal(creates, 1); assert.equal(session.has(RELOAD_KEY), false);
  mountBackgroundLifecycle({ eagle, win, onVisible: value => seen.push(value), onCreate: () => creates++ });
  assert.equal(creates, 1);
});

test('plugin stamp changes when a plugin file changes and is cached briefly', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stamp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.js'), 'one');
  let clock = 0;
  const stamp = createPluginStamp({ dirs: [dir, path.join(dir, 'missing')], now: () => clock });
  const first = await stamp();
  assert.match(first, /^[0-9a-f]{12}$/);
  await writeFile(path.join(dir, 'a.js'), 'two!');
  await utimes(path.join(dir, 'a.js'), new Date(), new Date(Date.now() + 5000));
  assert.equal(await stamp(), first);
  clock = 5000;
  assert.notEqual(await stamp(), first);
});
