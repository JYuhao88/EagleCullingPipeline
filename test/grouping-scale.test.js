import test from 'node:test';
import assert from 'node:assert/strict';
import { groupResults, groupResultsAsync, recallCrossDayDuplicates } from '../src/core/grouping.js';
const hash = '0'.repeat(64);
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
