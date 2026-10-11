import { createHash } from 'node:crypto';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { POSE_CACHE_KEY } from '../src/core/pose.js';
import { SCORER_CACHE_KEY } from '../src/core/scorer.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { writeSegmented } from '../src/core/segmented-results.js';
import { Checkpoints } from '../src/core/checkpoints.js';
import { RunStore } from '../src/server/run-store.js';
import { createRunsRouter } from '../src/server/runs-routes.js';

const args = process.argv.slice(2);
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const count = Number(value('--units', '100'));
if (!Number.isSafeInteger(count) || count < 1 || (process.platform === 'darwin' && count > 250)) {
  throw new Error('Local smoke limit is 250 units; larger scales run on Ray');
}
const root = await mkdtemp(path.join(os.tmpdir(), 'result-scale-'));
const run = { contractVersion: 1, id: 'synthetic', status: 'completed', unitCount: count, groupCount: Math.ceil(count / 10) };
const unitId = i => `unit:${i}`;
const payload = Array.from({ length: 768 }, (_, i) => Math.sin(i));
async function* rows(kind) {
  if (kind === 'groups') {
    for (let i = 0; i < count; i += 10) {
      const ids = Array.from({ length: Math.min(10, count - i) }, (_, j) => unitId(i + j));
      yield { contractVersion: 1, id: `group:${i}`, unitIds: ids, confidence: 'low', margin: 0,
        ranking: ids.map((id, j) => ({ unitId: id, rank: j + 1, score: .5, reasons: ['合成负载'] })),
        suggested: Object.fromEntries(ids.map(id => [id, 'candidate'])) };
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    if (kind === 'units') yield { contractVersion: 1, id: unitId(i), primaryItemId: String(i), itemIds: [String(i)] };
    if (kind === 'items') yield { id: String(i), name: `synthetic-${i}`, ext: 'jpg', tags: [] };
    if (kind === 'results') yield { contractVersion: 1, unitId: unitId(i), fingerprint: `synthetic-${i}`,
      metrics: { quality: null, aesthetic: null }, flags: [], embedding: payload,
      signals: { synthetic: true, measurements: payload }, geometry: payload };
  }
}
let server;
try {
  const store = new RunStore(root);
  await store.saveProgress(run);
  const writeStart = performance.now();
  const manifest = await writeSegmented(store.dir(run.id), Object.fromEntries(
    ['units', 'items', 'results', 'groups'].map(kind => [kind, rows(kind)])));
  const writeMs = performance.now() - writeStart;
  let bytes = (await stat(path.join(store.dir(run.id), 'results-index.json'))).size;
  for (const kind of Object.keys(manifest.indexes)) {
    const shards = new Set(Object.values(manifest.indexes[kind]).map(location => location[0]));
    for (const shard of shards) bytes += (await stat(path.join(store.dir(run.id), manifest.generation, `${kind}-${shard}.jsonl`))).size;
  }
  const route = createRunsRouter({ pipeline: {}, store: new RunStore(root) });
  server = createServer(async (req, res) => {
    try { if (!await route(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } }
    catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/runs/synthetic`;
  const firstStart = performance.now();
  const response = await fetch(`${base}/results?limit=20&filter=multi`);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.groups.length, Math.min(20, Math.ceil(count / 10)));
  const firstScreenMs = performance.now() - firstStart;
  const groupStart = performance.now();
  const single = await (await fetch(`${base}/results?groupId=group:0&limit=1`)).json();
  assert.equal(single.results.length, Math.min(count, 10));
  const singleGroupMs = performance.now() - groupStart;
  // Interrupt at the persisted grouping boundary, then run the real pipeline
  // through feature skips and ranking. Synthetic features never invoke models.
  const records = Array.from({ length: count }, (_, i) => ({ id: String(i), unitId: unitId(i),
    name: `synthetic-${i}`, itemIds: [String(i)], captureTime: new Date(i * 1000).toISOString(),
    exif: {}, sessionId: `synthetic-${Math.floor(i / 10)}` }));
  const fingerprints = records.map(record => createHash('sha256').update(JSON.stringify([
    undefined, 0, 0, record.itemIds, '', 'analysis-v6-exposure-gates', POSE_CACHE_KEY, SCORER_CACHE_KEY,
  ])).digest('hex'));
  let checkpoint = new Checkpoints(path.join(root, 'resume'));
  const initialStart = performance.now();
  for (let i = 0; i < count; i++) await checkpoint.put(`unit:${unitId(i)}`, { stage: 'focus',
    result: { unitId: unitId(i), metrics: { quality: null, aesthetic: null }, flags: [], faces: [],
      fingerprint: fingerprints[i] } });
  const groupingSignature = createHash('sha256').update(JSON.stringify(
    records.map((record, i) => [record.unitId, fingerprints[i]]))).digest('hex');
  const groups = [];
  for await (const group of rows('groups')) groups.push({ id: group.id, unitIds: group.unitIds });
  await checkpoint.put('grouping', { signature: groupingSignature, groups, duplicates: [] });
  const checkpointWriteMs = performance.now() - initialStart;
  const controller = new AbortController();
  const pipeline = new AnalysisPipeline({ root, cacheRoot: root, concurrency: 1,
    analyzer: async () => { throw new Error('Synthetic resume must skip model/metric analysis'); } });
  await assert.rejects(pipeline.run(records, { checkpoint, signal: controller.signal,
    onProgress(progress) { if (progress.stage === 'ranking') controller.abort(new Error('synthetic interruption')); }
  }), /synthetic interruption/);
  const resumeStart = performance.now();
  checkpoint = new Checkpoints(path.join(root, 'resume'));
  const resumed = await pipeline.run(records, { checkpoint });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.results.length, count);
  assert.equal(resumed.groups.length, groups.length);
  const resumeMs = performance.now() - resumeStart;
  const report = { units: count, synthetic: true, storageBytes: bytes, writeMs, firstScreenMs, singleGroupMs,
    checkpointWriteMs, resumeMs,
    resumeScope: 'real synthetic pipeline restart at grouping checkpoint through ranking; feature stages skipped, no inference',
    firstScreenScope: 'cold HTTP headers through JSON decoding; no browser rendering',
    maxRSSMiB: process.resourceUsage().maxRSS / 1024, node: process.version };
  await writeFile(value('--output', '/tmp/result-scale-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
