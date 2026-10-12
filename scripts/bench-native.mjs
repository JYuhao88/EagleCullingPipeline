#!/usr/bin/env node
// Run under the caller's global heavy-work lock. Real photos remain local.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { RunStore } from '../src/server/run-store.js';
import { createAnalysisServer } from '../src/server.js';
import { midKey, midSettings, readMid } from '../src/core/native-mid.js';

const id = process.argv[2];
if (!id) throw new Error('Usage: nice -n 15 node scripts/bench-native.mjs <local-run-id>');
const store = new RunStore();
const state = await store.get(id);
const primaryCandidate = state.items.find(item => ['jpg', 'jpeg'].includes(item.ext) && Math.max(item.width, item.height) >= 6000);
if (!primaryCandidate) throw new Error('Run needs a large JPEG unit');
const unit = state.units.find(unit => unit.primaryItemId === primaryCandidate.id);
const items = state.items.filter(item => unit.itemIds.includes(item.id));
const primary = items.find(item => item.id === unit.primaryItemId);
const dimensions = await sharp(primary.filePath || primary.path).metadata();
const swapped = dimensions.orientation >= 5 && dimensions.orientation <= 8;
const source = { width: swapped ? dimensions.height : dimensions.width, height: swapped ? dimensions.width : dimensions.height };
const pairedItems = items.filter(item => item !== primary);
const hash = async file => { const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const originals = await Promise.all(items.map(item => hash(item.filePath || item.path)));
const dir = await mkdtemp(path.join(os.tmpdir(), 'native-bench-'));
const key = await midKey(primary, { pairedItems });
const midFile = path.join(midSettings().cacheDir, `${key}.jpg`);
// Only remove this experiment's key in the owned native-mid directory.
await rm(`${midFile}.json`, { force: true }); await rm(midFile, { force: true });
const isolated = { root: dir, unitData: (...args) => store.unitData(...args) };
const app = createAnalysisServer({ port: 43331, runStore: isolated, pipeline: {}, updater: {
  isUpdating: () => false,
} });
let peak = process.memoryUsage().rss, phasePeak = peak;
const timer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  peak = Math.max(peak, rss); phasePeak = Math.max(phasePeak, rss);
}, 20);
const sample = async (url, options) => {
  phasePeak = process.memoryUsage().rss;
  const start = performance.now(); const response = await fetch(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  return { ms: performance.now() - start, peakRssMiB: Math.max(phasePeak, process.memoryUsage().rss) / 1024 ** 2,
    buffer, tier: response.headers.get('x-native-tier') };
};
try {
  await app.listen();
  const base = `http://127.0.0.1:43331/runs/${id}/native/${encodeURIComponent(unit.id)}`;
  const box = [0.25, 0.25, 0.5, 0.5], width = 800, height = Math.round(800 * source.height / source.width);
  const url = `${base}?box=${box.join(',')}&width=${width}&height=${height}`;
  const cold = await sample(url); assert.equal(cold.tier, 'original');
  const prefetch = await sample(`${base}/prefetch`, { method: 'POST' });
  const mid = JSON.parse(prefetch.buffer); assert.equal(mid.available, true);
  const cached = await readMid(primary, { pairedItems });
  const hot = [];
  for (let i = 0; i < 5; i++) { const response = await sample(url); assert.equal(response.tier, 'mid'); hot.push(response); }
  const a = await sharp(cold.buffer).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const b = await sharp(hot[0].buffer).removeAlpha().raw().toBuffer();
  assert.equal(a.length, b.length);
  let squared = 0, absolute = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i] - b[i]); squared += diff ** 2; absolute += diff; max = Math.max(max, diff);
  }
  const one = await sample(`${base}?box=${box.join(',')}&width=${Math.ceil(source.width / 4)}&height=${Math.ceil(source.height / 4)}`);
  assert.equal(one.tier, 'original');
  const after = await Promise.all(items.map(item => hash(item.filePath || item.path)));
  assert.deepEqual(after, originals);
  console.log(JSON.stringify({ source: { width: cached.source.width, height: cached.source.height, kind: cached.source.kind },
    display: { width, height }, mid: { width: mid.width, height: mid.height }, coldMs: cold.ms, prefetchMs: prefetch.ms,
    hotMs: hot.map(row => row.ms), coldPeakRssMiB: cold.peakRssMiB, prefetchPeakRssMiB: prefetch.peakRssMiB,
    hotPeakRssMiB: hot.map(row => row.peakRssMiB), coldTier: cold.tier, hotTier: hot[0].tier, oneToOneTier: one.tier,
    psnrDb: 10 * Math.log10(255 ** 2 / (squared / a.length)), maxError: max, meanAbsoluteError: absolute / a.length,
    sampledPeakRssMiB: peak / 1024 ** 2, resourceMaxRssMiB: process.resourceUsage().maxRSS / 1024,
    originalHashesUnchanged: true }, null, 2));
} finally { clearInterval(timer); await app.close(); await rm(dir, { recursive: true, force: true }); }
