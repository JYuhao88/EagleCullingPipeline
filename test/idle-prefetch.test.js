import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { inWindow, parseWindow, prefetchDecision, shouldCancelPrefetch, prefetchCandidates, createIdlePrefetcher, systemSignals }
  from '../src/plugin/idle-prefetch.js';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';

const at = (hour, minute = 0) => new Date(2026, 9, 12, hour, minute);
const ok = { enabled: true, connected: true, busy: false, visible: false, idleSeconds: 3600, onBattery: false, window: '01:00-07:00' };

test('time windows include the start, exclude the end, and may cross midnight', () => {
  assert.equal(inWindow(at(1), '01:00-07:00'), true);
  assert.equal(inWindow(at(7), '01:00-07:00'), false);
  assert.equal(inWindow(at(23, 30), '23:00-06:00'), true);
  assert.equal(inWindow(at(5, 59), '23:00-06:00'), true);
  assert.equal(inWindow(at(12), '23:00-06:00'), false);
  assert.deepEqual(parseWindow('25:00-07:00'), parseWindow());
  assert.deepEqual(parseWindow('03:00-03:00'), parseWindow());
});

test('prefetch only runs when enabled, plugged in, idle, hidden and not busy', () => {
  assert.equal(prefetchDecision({ ...ok, now: at(2) }).run, true);
  assert.equal(prefetchDecision({ ...ok, now: at(2), idleSeconds: null }).run, true, 'unknown idle falls back to the window');
  for (const [change, reason] of [[{ enabled: false }, '未开启'], [{ connected: false }, '服务未连接'], [{ busy: true }, '已有分析在进行'],
    [{ now: at(12) }, '不在预处理时段'], [{ visible: true }, '插件窗口正在使用'], [{ onBattery: true }, '使用电池供电'],
    [{ onBattery: null }, '无法确认电源状态'], [{ idleSeconds: 30 }, '电脑正在使用']]) {
    assert.deepEqual(prefetchDecision({ ...ok, now: at(2), ...change }), { run: false, reason });
  }
  assert.equal(shouldCancelPrefetch({ ...ok, now: at(2) }), false);
  assert.equal(shouldCancelPrefetch({ ...ok, now: at(2), idleSeconds: 20 }), true);
  assert.equal(shouldCancelPrefetch({ ...ok, now: at(2), visible: true }), true);
  assert.equal(shouldCancelPrefetch({ ...ok, now: at(8) }), true);
});

test('system signals prefer Electron powerMonitor and fall back to the Battery API', async () => {
  const electron = { powerMonitor: { getSystemIdleTime: () => 900, isOnBatteryPower: () => false } };
  assert.deepEqual(await systemSignals({ requireImpl: name => name === 'electron' ? electron : null, platform: 'win32' }),
    { idleSeconds: 900, onBattery: false });
  const nav = { getBattery: async () => ({ charging: false }) };
  assert.deepEqual(await systemSignals({ requireImpl: () => { throw new Error('missing'); }, nav, platform: 'win32' }),
    { idleSeconds: null, onBattery: true });
  const ioreg = { execFile: (file, args, options, done) => done(null, '"HIDIdleTime" = 720000000000') };
  assert.deepEqual(await systemSignals({ requireImpl: name => name === 'node:child_process' ? ioreg : {}, nav: {}, platform: 'darwin' }),
    { idleSeconds: 720, onBattery: null });
});

test('candidates are recent, unanalysed images newest first and capped', async () => {
  const now = Date.parse('2026-10-12T00:00:00Z'), day = 86400000;
  const items = [
    { id: 'old', ext: 'jpg', importedAt: now - 40 * day, modifiedAt: now - day },
    { id: 'video', ext: 'mp4', importedAt: now - day, modifiedAt: now - day },
    { id: 'gone', ext: 'jpg', importedAt: now - day, modifiedAt: now - day, isDeleted: true },
    { id: 'done', ext: 'ARW', importedAt: now - 2 * day, modifiedAt: now - day },
    { id: 'a', ext: 'jpg', importedAt: now - 3 * day, modifiedAt: now - day },
    { id: 'b', ext: 'heic', importedAt: now - 1 * day, modifiedAt: now - day },
    { id: 'c', ext: 'jpg', importedAt: now - 5 * day, modifiedAt: now - 50 * day },
  ];
  const eagle = { item: { getIdsWithModifiedAt: async () => items.map(({ id, modifiedAt }) => ({ id, modifiedAt })),
    getByIds: async ids => items.filter(item => ids.includes(item.id)) } };
  let asked;
  const ids = await prefetchCandidates({ eagle, now, limit: 2, analyzed: async list => { asked = list; return ['done']; } });
  assert.deepEqual(asked, ['b', 'done', 'a']);
  assert.deepEqual(ids, ['b', 'a']);
  const fallback = { item: { get: async options => { assert.deepEqual(options.fields, ['id', 'ext', 'importedAt', 'isDeleted']);
    return items; } } };
  assert.deepEqual(await prefetchCandidates({ eagle: fallback, now }), ['b', 'done', 'a', 'c']);
});

test('prefetcher starts read-only prefetch runs, throttles, and cancels on user activity', async () => {
  const storage = new Map([['eagle-culling-idle-prefetch', '1']]);
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const calls = [];
  let status = { active: null, prefetch: null }, visible = false, clock = at(2);
  const api = async (url, options) => {
    calls.push([url, options?.body ? JSON.parse(options.body) : null]);
    if (url === '/runs/status') return status;
    if (url === '/runs/analyzed') return { itemIds: [] };
    if (url === '/runs') return { id: 'run-p' };
    return {};
  };
  const eagle = { library: { path: '/lib.library' }, item: { get: async () => [{ id: 'x', ext: 'jpg', importedAt: clock.getTime() }] } };
  const prefetcher = createIdlePrefetcher({ storage: store, getApi: () => api, eagle, isVisible: () => visible, isConnected: () => true,
    readSignals: async () => ({ idleSeconds: 3600, onBattery: false }), clock: () => clock });
  assert.deepEqual(await prefetcher.tick(), { action: 'started', runId: 'run-p', count: 1 });
  const start = calls.find(([url]) => url === '/runs')[1];
  assert.deepEqual(start, { purpose: 'prefetch', libraryPath: '/lib.library', itemIds: ['x'],
    scope: { type: 'selection', label: '空闲预处理' } });
  status = { active: null, prefetch: { id: 'run-p', status: 'running' } };
  assert.equal((await prefetcher.tick()).action, 'running');
  visible = true;
  assert.equal((await prefetcher.tick({ force: true })).action, 'cancelled');
  assert.ok(calls.some(([url]) => url === '/runs/run-p/cancel'));
  visible = false; status = { active: null, prefetch: { id: 'run-p', status: 'cancelled' } };
  assert.equal((await prefetcher.tick()).action, 'wait', 'next attempt waits fifteen minutes');
  storage.set('eagle-culling-idle-prefetch', '0');
  calls.length = 0;
  assert.equal((await prefetcher.tick()).action, 'skip');
  assert.deepEqual(calls, [], 'disabled prefetch makes no requests');
});

test('server hides prefetch runs, yields them to user analysis, and prunes old prefetch runs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prefetch-runs-'));
  const store = new RunStore(root);
  const releases = [];
  const pipeline = { async run(records, { signal, onProgress }) {
    onProgress({ stage: 'metrics', completed: 0, total: 1, cached: 0 });
    await new Promise((resolve, reject) => {
      releases.push(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { results: [], groups: [] };
  } };
  const service = createAnalysisServer({ port: 0, pipeline, runStore: store });
  await service.listen();
  t.after(async () => {
    for (const release of releases) release();
    await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = body => fetch(base + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  assert.equal((await post({ purpose: 'prefetch', items: [] })).status, 400, 'prefetch needs explicit item ids');
  assert.equal((await post({ purpose: 'prefetch', items: [], itemIds: Array(301).fill('x') })).status, 400);
  const prefetch = await (await post({ purpose: 'prefetch', items: [], itemIds: [], performanceMode: 'turbo' })).json();
  assert.equal(prefetch.performanceMode, 'normal');
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.activeRunId, null); assert.equal(health.prefetchRunId, prefetch.id);
  let status = await (await fetch(base + '/runs/status')).json();
  assert.equal(status.active, null); assert.equal(status.prefetch.id, prefetch.id);
  const user = await post({ items: [] });
  assert.equal(user.status, 202, 'user analysis preempts prefetch instead of returning 409');
  assert.equal((await store.getRun(prefetch.id)).status, 'cancelled');
  status = await (await fetch(base + '/runs/status')).json();
  assert.notEqual(status.active.id, prefetch.id);
  assert.equal(status.prefetch.status, 'cancelled');
  assert.deepEqual((await (await fetch(base + '/runs')).json()).runs.map(run => run.id), [status.active.id]);
  for (let i = 0; i < 200 && status.active?.progress?.stage !== 'metrics'; i++) {
    await new Promise(r => setTimeout(r, 10));
    status = await (await fetch(base + '/runs/status')).json();
  }
  releases.at(-1)();
  for (let i = 0; i < 100 && (await (await fetch(base + '/runs/status')).json()).active; i++) await new Promise(r => setTimeout(r, 10));
  for (let index = 0; index < 6; index++) {
    await store.saveProgress({ id: `run-old-${index}`, status: 'completed', purpose: 'prefetch',
      startedAt: `2026-01-0${index + 1}T00:00:00Z` });
  }
  await store.prunePrefetchRuns(5);
  assert.equal((await store.prefetchRuns()).length, 5);
  assert.equal(await store.getRun('run-old-0'), null);
});
