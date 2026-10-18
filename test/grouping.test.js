import test from 'node:test';
import assert from 'node:assert/strict';
import { groupResults, groupResultsAsync, recallCrossDayDuplicates, GROUPING_CONFIG } from '../src/core/grouping.js';
const hash = '0'.repeat(64);
const at = (seconds) => new Date(Date.parse('2024-01-01T00:00:00Z') + seconds * 1000).toISOString();

test('grouping uses hash and time thresholds', () => {
  const groups = groupResults([
    { unitId: 'a', phash: '0000', captureTime: '2024-01-01T00:00:00Z' },
    { unitId: 'b', phash: '0001', captureTime: '2024-01-01T00:00:05Z' },
    { unitId: 'c', phash: '1111111111111111', captureTime: '2024-01-01T01:00:00Z' },
  ], GROUPING_CONFIG);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.unitIds.includes('a')).unitIds.length, 2);
});

test('chain-like similarity is split by group diameter while a real burst stays together', () => {
  const chain = groupResults([
    { unitId: 'a', phash: hash, embedding: [1, 0], captureTime: at(0) },
    { unitId: 'b', phash: '0'.repeat(63) + '1', embedding: [1, 0], captureTime: at(1) },
    { unitId: 'c', phash: '0'.repeat(62) + '11', embedding: [1, 0], captureTime: at(7) },
  ], { ...GROUPING_CONFIG, maxTimeSpanSeconds: 3 });
  assert.ok(chain.length >= 2);
  const burst = groupResults([
    { unitId: 'x', phash: hash, embedding: [1, 0], captureTime: at(0) },
    { unitId: 'y', phash: '0'.repeat(63) + '1', embedding: [1, 0], captureTime: at(1) },
    { unitId: 'z', phash: '0'.repeat(62) + '11', embedding: [1, 0], captureTime: at(2) },
  ], { ...GROUPING_CONFIG, maxTimeSpanSeconds: 3 });
  assert.equal(burst.length, 1);
  assert.equal(burst[0].size, 3);
});

test('visual A-B-C links cannot override complete-link diameter', () => {
  const vector = (angle) => [Math.cos(angle), Math.sin(angle)];
  const groups = groupResults([0, 0.3, 0.6].map((angle, i) => ({
    unitId: String(i), embedding: vector(angle), captureTime: 1000 + i * 100,
  })), { embeddingSimilarity: 0.78, minPairScore: 0.5, minDiameterScore: 0.9,
    temporalBonus: 0, sequenceBonus: 0 });
  assert.equal(groups.length, 2);
  assert.equal(Math.max(...groups.map((group) => group.size)), 2);
});

test('time buckets retain complete-link partition across boundaries and legacy inputs', async () => {
  const records = [59, 61, 118, 121].map((seconds, i) => ({ unitId: String(i), captureTime: seconds * 1000, phash: hash }));
  records.push({unitId:'missing', phash:hash});
  assert.deepEqual((await groupResultsAsync(records)).map(g=>g.unitIds), groupResults(records).map(g=>g.unitIds));
  assert.deepEqual(groupResults(records.slice(0,4)).map(g=>g.unitIds), [['0','1','2'],['3']]);
});

test('sessions separate bursts without changing visual or diameter gates', () => {
  assert.equal(groupResults([{unitId:'a',phash:hash,captureTime:1000,sessionId:'a'},
    {unitId:'b',phash:hash,captureTime:1001,sessionId:'b'}]).length,2);
});

test('async grouping yields and responds to cancellation', async () => {
  const records=Array.from({length:10000},(_,i)=>({unitId:String(i),captureTime:i*100000,phash:hash}));
  const controller=new AbortController();
  setImmediate(()=>controller.abort(new Error('stop')));
  await assert.rejects(groupResultsAsync(records,undefined,{signal:controller.signal,batchSize:1}),/stop/);
});

test('cross-day pHash recall covers radius without merging separate bursts', async () => {
  const records=[{unitId:'a',phash:hash,captureTime:1000},
    {unitId:'b',phash:'1111'+'0'.repeat(60),captureTime:86401000},
    {unitId:'c',phash:'11111'+'0'.repeat(59),captureTime:172801000}];
  const recall=await recallCrossDayDuplicates(records);
  assert.deepEqual(recall.get('b'),['a']);
  assert.deepEqual(recall.get('c'),['b']);
  assert.equal(groupResults(records).length,3);
});
