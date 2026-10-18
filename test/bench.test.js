import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluateSynthetic, evaluateTriage, evaluateCandidateSensitivity, compareSynthetic } from '../ml/bench/evaluate.mjs';
import { benchmarkRoot } from '../scripts/bench.mjs';

test('bench cache directory defaults to legacy location and supports an isolated provider namespace', () => {
  assert.equal(benchmarkRoot({}), path.resolve('data/cache/bench'));
  assert.equal(benchmarkRoot({ EAGLE_BENCH_ROOT: 'data/cache/pose-provider/bench' }),
    path.resolve('data/cache/pose-provider/bench'));
});

const result = (unitId, sharpness, flags = []) => ({ unitId, metrics: { sharpness }, flags });
test('synthetic ties get half credit; severe gate and source false reject have independent denominators', () => {
  const manifest = { pairs: [
    { sourceId: 's', degradedId: 'd1', sourceStem: 's', degradation: 'blur', expectedGate: 'blurry' },
    { sourceId: 's', degradedId: 'd2', sourceStem: 's', degradation: 'tilt' },
    { sourceId: 's2', degradedId: 'd3', sourceStem: 's2', degradation: 'blur', expectedGate: 'blurry' },
  ] };
  const report = evaluateSynthetic(manifest, [result('s', .9), result('d1', .1, ['blurry']),
    result('d2', .9), result('s2', .8, ['overexposed']), result('d3', .1)], { bootstrap: 20 });
  assert.equal(report.pairs, 3);
  assert.equal(report.accuracy, 2 / 3);
  assert.equal(report.tieAdjustedAccuracy, 2.5 / 3);
  assert.deepEqual(report.gate, { hits: 1, total: 2, rate: .5 });
  assert.equal(report.sourceCount, 2);
  assert.equal(report.sourceFalseReject.rate, .5);
  assert.equal(report.byDegradation.tilt.ties, 1);
  assert.equal(report.byDegradation.tilt.gate.rate, null);
  assert.throws(() => evaluateSynthetic(manifest, []), /Missing synthetic result/);
});
test('triage uses strong pairs only, time and random baselines, and group bootstrap', () => {
  const manifest = { status: 'ready', license: { status: 'verified' },
    groups: [{ id: 'g', split: 'validation', preferredIds: ['b'],
    images: [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 }],
    pairs: [{ winnerId: 'b', loserId: 'a', strength: .7 }, { winnerId: 'c', loserId: 'b', strength: .69 }] }] };
  const report = evaluateTriage(manifest, [result('a', .2), result('b', .9), result('c', .3)], { bootstrap: 20 });
  assert.equal(report.top1.rate, 1);
  assert.equal(report.pairwise.total, 1);
  assert.equal(report.pairwise.rate, 1);
  assert.equal(report.random.top1.rate, 1 / 3);
  assert.equal(report.chronological.top1.rate, 0);
  assert.equal(report.chronological.pairwise.rate, 0);
  assert.deepEqual(report.top1.ci, { low: 1, high: 1, samples: 20 });
  const tied = evaluateTriage(manifest, [result('a', .9), result('b', .9), result('c', .3)], { bootstrap: 20 });
  assert.equal(tied.top1.rate, .5);
  assert.equal(tied.pairwise.rate, .5);
});
test('unavailable corpus yields null metrics and never zero-percent accuracy', () => {
  const report = evaluateTriage({ status: 'unavailable', reason: 'license unverified' }, []);
  assert.equal(report.groups, 0);
  assert.throws(() => evaluateTriage({ status: 'ready', groups: [] }, []), /verified license/);
  assert.throws(() => evaluateSynthetic({ pairs: [] }, []), /nonempty pairs/);
  assert.equal(report.top1, null);
  assert.equal(report.pairwise, null);
});

test('a seriously flagged degraded image is gated even when its quality score is higher', () => {
  const manifest = { pairs: [{ sourceId: 's', degradedId: 'd', degradation: 'exposure', expectedGate: true }] };
  const report = evaluateSynthetic(manifest, [result('s', .1), result('d', .9, ['overexposed'])], { bootstrap: 20 });
  assert.equal(report.gate.hits, 1);
  assert.equal(report.rows[0].credit, 0);
  assert.equal(report.rows[0].standaloneGateRejected, true);
  assert.equal(report.rows[0].pairDecision, 'rejected');
});

test('extended comparison preserves old identity and reports regressions per category',()=>{
 const pair={id:'d',sourceId:'s',degradedId:'d',sha256:'abc',degradation:'blur',strength:1,expectedGate:true};
 const before=evaluateSynthetic({pairs:[pair]},[result('s',.9),result('d',.1,['blurry'])],{bootstrap:10});
 const after=evaluateSynthetic({pairs:[pair,{...pair,id:'d2',degradedId:'d2',sha256:'xyz',degradation:'new'} ]},
   [result('s',.9),result('d',.1,['blurry']),result('d2',.2)],{bootstrap:10});
 assert.equal(compareSynthetic(before,after,{allowExtended:true}).unchangedRows,true);
 assert.equal(compareSynthetic(before,after,{allowExtended:true}).additionalPairs,1);
 assert.equal(compareSynthetic(before,after,{allowExtended:true}).severeGateDelta,0);
 assert.throws(()=>compareSynthetic(before,after),/identical pairs/);
 after.rows[0].sha256='changed';
 assert.throws(()=>compareSynthetic(before,after,{allowExtended:true}),/identity mismatch/);
});
test('candidate sensitivity counts unknowns separately and never treats ties as preference',()=>{
 const manifest={pairs:[{id:'a',sourceId:'s',degradedId:'a',degradation:'tonal-gray',strength:'mild'},
   {id:'b',sourceId:'s',degradedId:'b',degradation:'tonal-gray',strength:'severe'}]};
 const r=(unitId,range,eligible=true)=>({unitId,candidateMeasurements:{tonal:{eligible,range,localContrast:.1}}});
 const report=evaluateCandidateSensitivity(manifest,[r('s',.5),r('a',.5),r('b',undefined,false)]).byDegradation['tonal-gray'];
 assert.equal(report.covered,1);assert.equal(report.na,1);assert.equal(report.ties,1);
 assert.equal(report.accuracy,0);assert.equal(report.tieAdjustedAccuracy,.5);
});
