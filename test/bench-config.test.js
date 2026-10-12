import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { benchmarkRoot } from '../scripts/bench.mjs';

test('bench cache directory defaults to legacy location and supports an isolated provider namespace', () => {
  assert.equal(benchmarkRoot({}), path.resolve('data/cache/bench'));
  assert.equal(benchmarkRoot({ EAGLE_BENCH_ROOT: 'data/cache/pose-provider/bench' }),
    path.resolve('data/cache/pose-provider/bench'));
});
