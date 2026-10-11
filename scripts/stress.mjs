#!/usr/bin/env node
// Synthetic only: no Eagle API, original photographs, model workers, or shared cache.
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { listEagleImages } from '../src/core/metrics.js';
import { buildCaptureUnits } from '../src/core/capture-units.js';
import { groupResultsAsync, recallCrossDayDuplicates } from '../src/core/grouping.js';
import { rankGroup, groupConfidence, suggestDecision } from '../src/core/ranking.js';
import { RunStore } from '../src/server/run-store.js';
import http from 'node:http';
import { createRunsRouter } from '../src/server/runs-routes.js';

const value = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const onRay = Boolean(process.env.STRESS_JOB_ID);
const count = value('--units', onRay ? 5000 : 200);
const indexCount = value('--index-units', onRay ? 100000 : 200);
if (!onRay && (count > 250 || indexCount > 1000)) throw new Error('Large stress runs require Ray');
if (![count, indexCount].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid unit count');
const report = { contractVersion: 1, synthetic: true, modelInference: 'deterministic stub',
  files: count * 2, units: count, node: process.version, stages: {}, memorySamples: [],
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length },
  filePayload: '16x16 JPEG with EXIF, repeated in JPG and mock ARW extension; no RAW decoding',
  groupingPayload: 'deterministic 64-bit hashes, four-frame bursts, 500 captures per session; embeddings omitted' };
const memory = stage => {
  const m = process.memoryUsage();
  report.memorySamples.push({ stage, rssMiB: m.rss / 1048576, heapMiB: m.heapUsed / 1048576 });
  if (m.rss > 3 * 1024 ** 3) throw new Error('3 GiB memory soft limit exceeded');
};
async function measure(stage, size, fn) {
  console.error(`stress: ${stage} (${size})`);
  memory(`${stage}:before`);
  const start = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - start;
  report.stages[stage] = { elapsedMs, count: size, perSecond: size / (elapsedMs / 1000) };
  memory(`${stage}:after`);
  console.error(`stress: ${stage} complete in ${elapsedMs.toFixed(1)} ms`);
  return result;
}
const capture = index => new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 500), 10, 0,
  Math.floor(index % 500 / 4) * 10, (index % 4) * 250)).toISOString();
const hash = index => createHash('sha256').update(`capture-${Math.floor(index / 4)}`)
  .digest('hex').slice(0, 16).split('')
  .map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
const stub = (unit, index) => ({ contractVersion: 1, unitId: unit.id, name: `DSC${String(index).padStart(6, '0')}`,
  sessionId: `session-${Math.floor(index / 500)}`, captureTime: capture(index),
  fingerprint: `stub-${index}`, phash: hash(index), dhash: hash(index), previewPath: null, faces: [], flags: [],
  metrics: { sharpness: .6 + index % 4 * .08, exposure: .85, quality: null, aesthetic: null, faces: 0, eyesClosed: 0 },
});
const root = await mkdtemp(path.join(os.tmpdir(), 'eagle-scale-stress-'));
let app;
try {
  const library = path.join(root, 'synthetic.library');
  const images = path.join(library, 'images');
  await mkdir(images, { recursive: true });
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3,
    background: { r: 80, g: 120, b: 160 } } })
    .withExif({ IFD0: { Make: 'Synthetic', Model: 'Stress',
      DateTimeOriginal: '2026:01:01 10:00:00', SubSecTimeOriginal: '250', OffsetTimeOriginal: '+00:00',
    } }).jpeg().toBuffer();
  await measure('setup', count * 2, async () => {
    let cursor = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (cursor < count * 2) {
        const n = cursor++;
        const index = Math.floor(n / 2);
        const ext = n % 2 ? 'arw' : 'jpg';
        const id = `item-${n}`;
        const name = `DSC${String(index).padStart(6, '0')}`;
        const directory = path.join(images, `${id}.info`);
        await mkdir(directory);
        await writeFile(path.join(directory, `${name}.${ext}`), jpeg);
        await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
          id, name, ext, width: 16, height: 16, size: jpeg.length, captureTime: capture(index),
        }));
      }
    }));
  });
  const items = await measure('scan', count * 2, () => listEagleImages(library));
  if (items.some(item => !item.captureTime || !item.device || !item.fileStat)) throw new Error('EXIF/stat missing');
  report.scanMetadata = { exifComplete: true, statComplete: true, example: items[0].exif };
  const units = await measure('pairing', count * 2, () => buildCaptureUnits(items));
  if (items.length !== count * 2 || units.length !== count || units.some(u => u.pairing !== 'paired')) {
    throw new Error(`synthetic pairing mismatch: ${items.length} files, ${units.length} units`);
  }
  const results = await measure('modelStub', count, () => units.map(stub));
  const grouped = await measure('grouping', count, () => groupResultsAsync(results));
  const byId = new Map(results.map(r => [r.unitId, r]));
  const groups = await measure('ranking', count, () => grouped.map(group => {
    const ranking = rankGroup(group.items, undefined, { averageSimilarity: group.averageSimilarity });
    return { contractVersion: 1, id: group.id, unitIds: group.unitIds, ranking,
      ...groupConfidence({ unitIds: group.unitIds, ranking }, byId),
      suggested: Object.fromEntries(ranking.map(e => [e.unitId, suggestDecision(e, byId.get(e.unitId), ranking.length)])),
    };
  }));
  const store = new RunStore(path.join(root, 'runs'));
  const run = { id: 'synthetic-stress', status: 'completed', contractVersion: 1,
    itemCount: items.length, unitCount: units.length, groupCount: groups.length, progress: { stage: 'done' } };
  await measure('storage', count, () => store.save(run, { items, units, results, groups }));
  const resultsBytes = (await stat(path.join(store.dir(run.id), 'results.json'))).size;
  await measure('progressStorage', 20, async () => {
    // A burst simulates 5000 callbacks; route throttling unit test proves two stage metadata writes.
    for (let n = 0; n < 20; n++) await store.saveProgress({ ...run, progress: { completed: n * 250 } });
  });
  report.storage = { resultsBytes, resultPayloadWrites: 1, progressMetadataWrites: 20,
    baselineProgressBytesEstimate: resultsBytes * count };
  const route = createRunsRouter({ store, pipeline: { run() { throw new Error('no model'); } } });
  const server = http.createServer(async (req, res) => {
    try { await route(req, res, new URL(req.url, 'http://localhost')); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  app = { server, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    await measure('httpRun', 1, async () => (await fetch(`${base}/runs/${run.id}`)).json());
    const firstStart = performance.now();
    const response = await fetch(`${base}/runs/${run.id}/results`);
    const headersMs = performance.now() - firstStart;
    const text = await response.text();
    const decoded = JSON.parse(text);
    report.httpFirstScreen = { status: response.status, headersMs, bodyAndParseMs: performance.now() - firstStart,
      bytes: Buffer.byteLength(text), groups: decoded.groups.length,
      scope: 'HTTP full results transfer plus JSON parse; browser rendering not measured' };
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    report.httpFirstScreen = { blocked: true, reason: error.message };
  }
  const indexed = Array.from({ length: indexCount }, (_, i) => stub({ id: `index-${i}` }, i));
  await measure('index100k', indexCount, () => new Map(indexed.map(r => [r.unitId, r])));
  const recall = await measure('crossDayRecall100k', indexCount, () => recallCrossDayDuplicates(indexed));
  report.index = { units: indexCount, recallEntries: recall.size,
    projectedResultBytes: resultsBytes / count * indexCount };
  const largeGroups = await measure('grouping100k', indexCount, () => groupResultsAsync(indexed));
  report.index.groups = largeGroups.length;
  // Identical hash across many days stresses bounded duplicate recall without merging distinct sessions.
  const duplicates = indexed.map(r => ({ ...r, phash: '0'.repeat(64), dhash: '0'.repeat(64) }));
  const degenerate = await measure('identicalHashRecall100k', indexCount, () => recallCrossDayDuplicates(duplicates));
  report.index.identicalHashRecallEntries = degenerate.size;
  report.peakRssMiB = process.resourceUsage().maxRSS / 1024;
  report.groupCount = groups.length;
  const output = process.argv.indexOf('--output');
  if (output >= 0) await writeFile(process.argv[output + 1], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app?.server.listening) await app.close();
  await rm(root, { recursive: true, force: true });
}
