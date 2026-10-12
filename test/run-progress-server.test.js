import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunsRouter } from '../src/server/runs-routes.js';

test('HTTP progress heartbeat advances elapsed time and persists final overall progress', async () => {
  const writes = [];
  const active = { run: null };
  let release;
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
  const router = createRunsRouter({ pipeline, store, active });
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
    await delay(1100);
    const current = (await invoke('GET', `/runs/${id}`)).response;
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
    await delay(1100);
    assert.equal(writes.length, count);
  } finally { release(); }
});
