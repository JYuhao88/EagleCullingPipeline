import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { RunProgress, measuredWeights, PROGRESS_WEIGHTS } from '../src/core/run-progress.js';
import { createRunsRouter } from '../src/server/runs-routes.js';

test('overall progress stays monotonic through stages and scanning passes', () => {
  let now = 0;
  const tracker = new RunProgress({ now: () => now });
  let previous = 0;
  for (const [stage, completed, total, phase] of [
    ['scanning', 10, 10, 'files'], ['scanning', 0, 20, 'metadata'],
    ['metrics', 0, 10], ['metrics', 10, 10], ['embedding', 0, 10],
    ['faces', 0, 10], ['pose', 0, 20], ['focus', 0, 10],
    ['grouping', 0, 10], ['ranking', 0, 5], ['done', 10, 10],
  ]) {
    now += 1000;
    const value = tracker.update({ stage, completed, total, phase });
    assert.ok(value.overallPercent >= previous);
    previous = value.overallPercent;
  }
  assert.equal(previous, 100);
  assert.equal(tracker.last.remainingSeconds, 0);
  assert.equal(tracker.last.elapsedSeconds, 11);
});

test('ETA uses a warmed sliding window and becomes unknown after a stall or stage switch', () => {
  let now = 0;
  const tracker = new RunProgress({ now: () => now, windowMs: 10000 });
  const emit = completed => tracker.update({ stage: 'focus', completed, total: 100 });
  assert.equal(emit(0).remainingSeconds, null);
  now = 3000;
  assert.equal(emit(3).remainingSeconds, null);
  now = 6000;
  const warmed = emit(6);
  assert.equal(warmed.stageRatePerSecond, 1);
  assert.ok(warmed.remainingSeconds > 94);
  now = 10000; emit(10);
  now = 15000; emit(20);
  now = 20000;
  assert.equal(emit(30).stageRatePerSecond, 2);
  now = 40000;
  assert.equal(emit(30).remainingSeconds, null);
  assert.equal(tracker.update({ stage: 'grouping', completed: 0, total: 1 }).remainingSeconds, null);
});

test('unknown totals, zero units and resumed stages never invent an ETA', () => {
  let now = 0;
  const tracker = new RunProgress({ now: () => now });
  tracker.update({ stage: 'scanning', completed: 0, total: 0 });
  now = 20000;
  assert.equal(tracker.snapshot().remainingSeconds, null);
  assert.equal(tracker.update({ stage: 'focus', completed: 80, total: 100 }).remainingSeconds, null);
  assert.equal(tracker.update({ stage: 'done', completed: 0, total: 0 }).overallPercent, 100);
});

test('only successful complete measurements supply future stage weights', () => {
  assert.equal(measuredWeights([{ status: 'failed', progress: {} }]), null);
  const stageDurationsMs = Object.fromEntries(Object.keys(PROGRESS_WEIGHTS).map(stage => [stage, 1000]));
  stageDurationsMs.focus = 9000;
  const weights = measuredWeights([{ status: 'completed', progress: { stageDurationsMs } }]);
  assert.equal(weights.focus, 9 / 16);
  assert.equal(weights.metrics, 1 / 16);
});

test('optional observations keep progress monotonic, report their duration and give finite ETA only after warming', () => {
  let now = 0;
  const tracker = new RunProgress({ now: () => now });
  const before = tracker.update({ stage: 'focus', completed: 10, total: 10 });
  assert.equal(before.stageWeights.observations, undefined);
  now = 1000;
  const start = tracker.update({ stage: 'observations', completed: 0, total: 20 });
  assert.ok(start.overallPercent >= before.overallPercent);
  assert.equal(start.remainingSeconds, null);
  now = 7000;
  const measured = tracker.update({ stage: 'observations', completed: 6, total: 20 });
  assert.equal(measured.stageRatePerSecond, 1);
  assert.ok(Number.isFinite(measured.remainingSeconds));
  now = 8000;
  const next = tracker.update({ stage: 'grouping', completed: 0, total: 1 });
  assert.ok(next.overallPercent >= measured.overallPercent);
  assert.equal(next.stageDurationsMs.observations, 7000);
});

test('HTTP progress heartbeat advances elapsed time and persists final overall progress', async () => {
  const writes = [];
  const active = { run: null };
  let release, clock = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const store = {
    list: async () => ({ runs: [] }),
    saveProgress: async run => { writes.push(JSON.parse(JSON.stringify({ ...run, controller: undefined }))); },
    save: async run => { writes.push(JSON.parse(JSON.stringify(run))); },
  };
  const pipeline = { run: async (records, { id, onProgress }) => {
    onProgress({ stage: 'metrics', completed: 1, total: 10 });
    onProgress({ stage: 'focus', completed: 1, total: 10 });
    await gate;
    return { id, status: 'completed', results: [], groups: [],
      progress: { stage: 'done', completed: 0, total: 0 } };
  } };
  const router = createRunsRouter({ pipeline, store, active, heartbeatMs: 5, now: () => clock });
  const invoke = async (method, pathname, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = method;
    let response, status;
    await router(req, { writeHead: code => { status = code; },
      end: value => { response = JSON.parse(value); } }, new URL(pathname, 'http://localhost'));
    return { status, response };
  };
  try {
    const start = await invoke('POST', '/runs', { items: [] });
    assert.equal(start.status, 202);
    const id = start.response.id;
    clock = 1100;
    let current;
    for (let n = 0; n < 200; n++) {
      current = (await invoke('GET', `/runs/${id}`)).response;
      if (current.progress.elapsedSeconds >= 1) break;
      await delay(5);
    }
    assert.equal(current.progress.stage, 'focus');
    assert.ok(current.progress.elapsedSeconds >= 1);
    assert.equal(current.progress.remainingSeconds, null);
    assert.ok(current.progress.overallPercent > 0);
    release();
    for (let n = 0; n < 50 && active.run; n++) await delay(10);
    assert.equal(active.run, null);
    const finished = writes.at(-1);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.progress.overallPercent, 100);
    assert.equal(finished.progress.remainingSeconds, 0);
    assert.ok(finished.progress.stageDurationsMs.focus >= 1000);
    const count = writes.length;
    clock += 1100;
    await delay(50);
    assert.equal(writes.length, count);
  } finally { release(); }
});
