import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, filterQueue } from '../src/server/queue.js';

test('queue modes preserve group/rank order and classify issues', () => {
  const rows = [
    { unitId: 'a', groupIndex: 0, rank: 1, groupSize: 2, suggested: 'rejected', flags: [], confidence: 'low' },
    { unitId: 'b', groupIndex: 0, rank: 2, groupSize: 2, suggested: 'candidate', flags: ['blurry'], confidence: 'low' },
    { unitId: 'c', groupIndex: 1, rank: 1, groupSize: 1, suggested: 'selected', flags: [], confidence: 'high', human: 'selected' }
  ];
  assert.deepEqual(filterQueue(rows, 'rejects').map(row => row.unitId), ['a']);
  assert.deepEqual(filterQueue(rows, 'issues').map(row => row.unitId), ['b']);
  assert.deepEqual(filterQueue(rows, 'undecided').map(row => row.unitId), ['a', 'b']);
  assert.deepEqual(filterQueue(rows, 'uncertain').map(row => row.unitId), ['a', 'b']);
});

test('queue builder handles a synthetic 20k-unit run within a generous bound', async () => {
  const units = Array.from({ length: 20000 }, (_, index) => ({ id: `u${index}`, primaryItemId: `i${index}` }));
  const results = units.map(unit => ({ unitId: unit.id, flags: [] }));
  const groups = units.map((unit, index) => ({ id: `g${index}`, unitIds: [unit.id],
    suggested: { [unit.id]: index % 3 === 0 ? 'rejected' : 'candidate' },
    ranking: [{ unitId: unit.id, rank: 1 }] }));
  const store = { dir: () => '/tmp/queue-test', get: async () => ({ run: { id: 'run' }, units, results,
    items: [], groups }) };
  const started = performance.now(); const queue = await buildQueue(store, 'run');
  assert.equal(queue.rows.length, 20000); assert.ok(performance.now() - started < 5000);
});

test('inspector navigation moves forward from the current unit and wraps', async () => {
  const { nextInQueue } = await import('../src/plugin/inspector/inspector.js');
  const order = ['a', 'b', 'c', 'd'];
  const rows = [{ unitId: 'a', primaryItemId: 'A' }, { unitId: 'c', primaryItemId: 'C' }];
  assert.equal(nextInQueue(rows, 'b', order).unitId, 'c');
  assert.equal(nextInQueue(rows, 'c', order).unitId, 'a');
  assert.equal(nextInQueue(rows, 'zz', order).unitId, 'a');
  assert.equal(nextInQueue([{ unitId: 'a', primaryItemId: 'A' }], 'a', order), null);
});
