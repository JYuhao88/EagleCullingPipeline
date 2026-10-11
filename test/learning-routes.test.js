import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { RunStore } from '../src/server/run-store.js';
import { handleReviewRoute } from '../src/server/review-routes.js';
import { learningServices, learningGroups, applyPreferenceSnapshot, restorePreferenceOrder } from '../src/server/learning-routes.js';
import { presentation, createLearningPanel } from '../src/plugin/learning-panel.js';
import { LearningData } from '../src/core/learning-data.js';
import { fitPreferenceHead } from '../src/core/preference-head.js';

test('learning panel restores the selected profile when the page is reopened', async t => {
  const storage = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  const requests = [];
  function panel() {
    const fields = new Map();
    const root = { querySelector: key => {
      if (!fields.has(key)) fields.set(key, { value: 'default', addEventListener: (_type, callback) => {
        fields.get(key).click = callback;
      }, replaceChildren: () => {} });
      return fields.get(key);
    } };
    let current = { runId: 'one', data: { groups: [] } };
    const instance = createLearningPanel({ root, state: () => current, setState: value => { current = value; },
      render: () => {}, api: async (_url, options) => {
        if (options) { requests.push(JSON.parse(options.body).profileId); return { config: {}, snapshots: [] }; }
        return { groups: [] };
      } });
    return { instance, fields };
  }
  const first = panel(); await first.instance.refresh();
  first.fields.get('#learningProfile').value = 'client';
  // Use the same UI listener as the Load profile button.
  await first.fields.get('#learningLoad').click();
  const reopened = panel(); await reopened.instance.refresh();
  assert.equal(reopened.fields.get('#learningProfile').value, 'client');
  assert.equal(reopened.instance.context().profileId, 'client');
  assert.deepEqual(requests, ['default', 'client', 'client']);
});

test('decisions retain their storage contract while exposure/bulk/profile persist across runs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w7-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runStore = new RunStore(path.join(root, 'runs'));
  const items = [], units = [], results = [];
  for (const id of ['a', 'b']) {
    const file = path.join(root, `${id}.jpg`); await writeFile(file, id);
    items.push({ id, path: file }); units.push({ id, primaryItemId: id, itemIds: [id] });
    results.push({ unitId: id, metrics: { sharpness: id === 'a' ? 0.6 : 0.9 }, embedding: [0.1, 0.2] });
  }
  const group = { id: 'g', unitIds: ['a', 'b'], ranking: [{ unitId: 'a', rank: 1, score: 0.6 },
    { unitId: 'b', rank: 2, score: 0.5 }], suggested: { a: 'selected', b: 'candidate' } };
  await runStore.save({ id: 'one', status: 'completed' }, { items, units, results, groups: [group] });
  let response;
  const ctx = { runStore, readBody: async req => req.body,
    json: (_res, status, body) => { response = { status, body }; } };
  const call = async (suffix, body, method = 'POST') => {
    assert.equal(await handleReviewRoute({ method, url: `/runs/one/${suffix}`, body }, {}, ctx), true);
    return response;
  };
  const defaults = await call('learning', {}, 'GET');
  assert.equal(defaults.body.config.enabled, false); assert.equal(defaults.body.config.pixelTier, 0);
  await call('learning/config', { profileId: 'client', config: { halfLifeDays: 30 } });
  await call('learning/exposure', { profileId: 'client', groupId: 'g', order: ['b', 'a'], viewport: ['b'], aiVisible: false });
  const saved = await call('decisions', { decisions: [{ unitId: 'a', action: 'selected', tie: false, reason: 'test' }],
    learning: { profileId: 'client', signal: 'bulk' } });
  assert.equal(saved.status, 200); assert.equal(saved.body.decisions[0].reason, 'test');
  assert.equal(saved.body.learningWarning, undefined);
  const stored = JSON.parse(await readFile(path.join(runStore.dir('one'), 'decisions.json'), 'utf8'));
  assert.equal(stored[0].profileId, undefined);
  const { dataStore } = learningServices(ctx);
  const events = await dataStore.events.read();
  assert.equal(events[0].type, 'exposure'); assert.equal(events[0].display[0].unitId, 'b');
  assert.equal(events[0].display[0].inViewport, true); assert.equal(events[0].aiVisible, false);
  assert.equal(events[1].signal, 'bulk'); assert.equal(events[1].profileId, 'client');
  assert.equal((await learningGroups(dataStore, 'client')).length, 1);
  assert.equal((await learningGroups(dataStore, 'default')).length, 0);
  assert.equal(events[1].exposureEventId, events[0].id);
  assert.equal(events[1].exposureKnown, true);
  const headBefore = fitPreferenceHead(await learningGroups(dataStore, 'client'));
  for (const item of items) await rm(item.path);
  const reloaded = new LearningData(dataStore.root);
  assert.deepEqual(fitPreferenceHead(await learningGroups(reloaded, 'client')), headBefore);
  const before = await readFile(path.join(runStore.dir('one'), 'results-index.json'), 'utf8');
  const refused = await call('learning/apply', { profileId: 'client' });
  assert.equal(refused.status, 409);
  assert.equal(await readFile(path.join(runStore.dir('one'), 'results-index.json'), 'utf8'), before);
});

test('L1 apply preserves severe gate strata, reviewed groups and defaults', async () => {
  const good = { metrics: { sharpness: 0.2 } }, bad = { metrics: { sharpness: 0.9 } };
  const head = fitPreferenceHead([{ id: 'train', time: 1, candidates: [{ hash: 'a', feature: good },
    { hash: 'b', feature: bad }], winners: ['b'] }]);
  const groups = [{ id: 'g', unitIds: ['a', 'b'], confidence: 'high', margin: 0.2,
    suggested: { a: 'selected', b: 'rejected' }, ranking: [{ unitId: 'a', rank: 1, score: 0.6, reasons: [] },
    { unitId: 'b', rank: 2, score: 0.8, reasons: ['硬伤门槛：排在通过者之后'] }] }];
  const data = { groups, results: [{ unitId: 'a', ...good }, { unitId: 'b', ...bad }] };
  const profile = { config: { enabled: true }, report: { ready: true }, head: { ...head, snapshotId: "v-test" } };
  const hashes = new Map([['a', 'a'], ['b', 'b']]); const features = new Map([['a', good], ['b', bad]]);
  const applied = await applyPreferenceSnapshot(data, [], profile, hashes, features);
  assert.equal(applied.data.groups[0].ranking[0].unitId, 'a');
  const restored = restorePreferenceOrder(applied.data, []);
  assert.equal(restored.data.groups[0].ranking[0].unitId, 'a');
  assert.equal(restored.data.groups[0].preferenceSnapshot, undefined);
  assert.deepEqual(restored.data.groups, data.groups);
  const reviewed = await applyPreferenceSnapshot(data, [{ unitId: 'b', source: 'human' }], profile, hashes, features);
  assert.deepEqual(reviewed.data.groups, data.groups); assert.equal(reviewed.changedGroups, 0);
  assert.equal((await applyPreferenceSnapshot(data, [], { ...profile, config: { enabled: false } }, hashes, features)).changedGroups, 0);
});

test('debias treatment is stable, small and disabled by default', () => {
  const group = { id: 'g', unitIds: ['a', 'b'], ranking: [{ unitId: 'a', rank: 1 }, { unitId: 'b', rank: 2 }] };
  assert.equal(presentation(group).aiVisible, true);
  let controls = 0;
  for (let i = 0; i < 1000; i++) {
    const input = { ...group, id: `group-${i}` }, first = presentation(input, true);
    assert.deepEqual(first, presentation(input, true));
    if (!first.aiVisible) { controls++; assert.deepEqual(first.order, ['b', 'a']); }
  }
  assert.ok(controls >= 20 && controls <= 80);
});
