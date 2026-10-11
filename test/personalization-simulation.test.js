import test from 'node:test';
import assert from 'node:assert/strict';
import { randomGenerator, simulateGroups, runSimulation, renderLearningCurve } from '../scripts/eval-personalization.mjs';

const pools = Array.from({ length: 10 }, (_, index) => ({ id: `source-${index}`, candidates:
  ['dark', 'bright'].map((tone, rank) => ({ hash: `${index}-${tone}`, baselineScore: rank,
    feature: { metrics: { quality: 0.5, sharpness: 0.5, raw: { meanLuma: rank ? 220 : 30 } } } })) }));

test('simulated events are deterministic, preserve exposure, and mark weak bulk acceptance', () => {
  const first = simulateGroups(pools, { count: 200 });
  assert.deepEqual(first, simulateGroups(pools, { count: 200 }));
  assert.equal(first.length, 200);
  assert(first.some(group => group.signal === 'bulk'));
  assert(first.some(group => group.signal === 'corrected'));
  for (const group of first) assert.deepEqual(group.exposure.shownHashes, group.candidates.map(c => c.hash));
  assert.equal(randomGenerator(5)(), randomGenerator(5)());
});

test('future source holdout learns hidden preference, detects switch and renders exportable curve', () => {
  const result = runSimulation(pools);
  assert.equal(result.actionCount, 400);
  assert.equal(result.holdoutSources, 3);
  assert.deepEqual(result.curve.map(row => row.groups), [10, 25, 50, 100, 200]);
  assert(result.curve.every(row => row.sampleCount === 3));
  assert(result.curve.every(row => row.before.estimate === 0 && row.after.estimate === 1));
  assert.equal(result.drift.detected, true);
  assert(result.preferenceSwitch.halfLife20Days.after.estimate > result.preferenceSwitch.noDecay.after.estimate);
  const svg = renderLearningCurve([{ name: 'fixture', result }]);
  assert(svg.startsWith('<svg'));
  assert(svg.includes('bootstrap 95% CI'));
  assert.throws(() => runSimulation(pools.slice(0, 2)), /Insufficient/);
});

test('simulated user and baseline preserve hard-gate strata and actual L0 rank', () => {
  const source = { id: 'gated', candidates: pools[0].candidates.map((candidate, index) => ({
    ...candidate, tier: index === 0 ? 2 : 0, baselineRank: index === 0 ? 2 : 1,
    baselineScore: index === 0 ? 1 : 0 })) };
  const actions = simulateGroups([source], { count: 100, bulkFraction: 0.5 });
  assert(actions.every(group => group.winners[0] === '0-bright'));
  assert(actions.some(group => group.signal === 'bulk'));
  assert(actions.some(group => group.signal === 'explicit'));
});
