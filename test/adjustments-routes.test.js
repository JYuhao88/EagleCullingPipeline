import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/server/run-store.js';
import { handleAdjustmentsRoute } from '../src/server/adjustments-routes.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'adjustments-')); t.after(() => rm(root, { recursive: true, force: true }));
  const runStore = new RunStore(root);
  await runStore.save({ id: 'r1', startedAt: '2026-10-18T00:00:00Z', status: 'completed', libraryPath: '/fixture.library' },
    { units: [], items: [], results: [], groups: [] });
  const call = async (method, unit, body) => {
    let reply;
    const ctx = { runStore, readBody: async () => body, json: (res, status, value) => { reply = { status, value }; } };
    await handleAdjustmentsRoute({ method, url: `/runs/r1/adjustments${unit ? `/${encodeURIComponent(unit)}` : ''}` }, {}, ctx);
    return reply;
  };
  return { call, file: path.join(runStore.dir('r1'), 'adjustments.json') };
}

test('saves for different photos at the same moment are all kept, and clearing the last one removes the file', async t => {
  const { call, file } = await setup(t);
  const saves = await Promise.all([call('PUT', 'u1', { exposure: 1 }), call('PUT', 'u 2', { whites: -0.3, contrast: 0 }),
    call('PUT', 'u3', { shadows: 0.5 })]);
  assert.deepEqual(saves.map(reply => reply.status), [200, 200, 200]);
  assert.deepEqual((await call('GET')).value, { u1: { exposure: 1 }, 'u 2': { whites: -0.3 }, u3: { shadows: 0.5 } });
  assert.deepEqual((await call('GET', 'u 2')).value, { whites: -0.3 });
  assert.equal((await call('PUT', 'u1', { exposure: 9 })).status, 400);
  await Promise.all(['u1', 'u 2', 'u3'].map(unit => call('PUT', unit, {})));
  await assert.rejects(access(file));
  assert.deepEqual((await call('GET', 'u1')).value, {});
});
