// Uses only dev-review-fixture's fake Eagle Web API, never a real Eagle library.
import assert from 'node:assert/strict';
import { createApi } from '../src/plugin/api.js';
import { createLiveWriteback, LIVE_KEYS } from '../src/plugin/live-writeback.js';
const base = 'http://127.0.0.1:43451';
const api = createApi(base);
const state = await api('/fixture/state');
assert.ok(Array.isArray(state.originals), 'Start the review fixture before running this simulation');
const runId = 'fixture-8';
const data = await api(`/runs/${runId}/results`);
const ids = data.units.slice(0, 3).map(unit => unit.id);
const values = new Map([[LIVE_KEYS.enabled, '1'], [LIVE_KEYS.star, '1']]);
const status = [];
const queue = createLiveWriteback({ api, storage: { getItem: key => values.get(key) },
  onStatus: (message, error) => status.push({ message, error }) });
async function save(decisions) {
  await api(`/runs/${runId}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions }) });
  queue.schedule(runId, decisions.map(row => row.unitId));
}
await save([{ unitId: ids[0], action: 'selected', source: 'human' }]);
await save([{ unitId: ids[1], action: 'selected', source: 'human' }, { unitId: ids[2], action: 'rejected', source: 'human' }]);
await queue.flush();
let eagle = await api('/fixture/state');
const chosen = eagle.items.find(item => item.id === data.units[0].primaryItemId);
assert.ok(chosen.tags.includes('AI精选')); assert.equal(chosen.star, 5);
assert.equal(eagle.items.find(item => item.id === data.units[1].primaryItemId).star, 3);
await save([{ unitId: ids[2], clear: true }]); await queue.flush();
eagle = await api('/fixture/state');
assert.deepEqual(eagle.items.find(item => item.id === data.units[2].primaryItemId),
  state.originals.find(item => item.id === data.units[2].primaryItemId));
await queue.cancel(); // Same barrier as the finish dialog's revert button.
const result = await api(`/runs/${runId}/writeback/revert`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply: true })
});
assert.equal(result.results.some(row => row.ok === false), false);
eagle = await api('/fixture/state');
for (const unit of data.units) {
  assert.deepEqual(eagle.items.find(item => item.id === unit.primaryItemId),
    state.originals.find(item => item.id === unit.primaryItemId));
}
assert.equal(status.some(row => row.error), false);
console.log(JSON.stringify({ passed: true, decisions: 3, undo: 1, restoredItems: data.units.length,
  eagleWriteRequests: eagle.writes.length - state.writes.length, tagsAndStarsRestored: true }, null, 2));
