#!/usr/bin/env node
import path from 'node:path';
import { readFile, mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { choosePreview } from '../src/core/previews.js';
import { analyzeImage } from '../src/core/metrics.js';
import { score } from '../src/core/scorer.js';
import { embedImage } from '../src/core/embeddings.js';
import { withNativeImage } from '../src/core/native-image.js';
import { analyzeFocus, readMakerFocus } from '../src/core/focus.js';

const runId = process.argv[2] || 'run-1791546991006';
const limit = Math.max(20, Math.min(40, Number(process.argv[3] || 20)));
const cacheBase = await realpath('data/cache');
const profileBase = path.join(cacheBase, 'w23-decode');
await mkdir(profileBase, { recursive: true });
const coldRoot = await mkdtemp(path.join(profileBase, 'profile-'));
console.error(`Cold cache: ${coldRoot}`);
const run = JSON.parse(await readFile(path.join('data/runs', runId, 'results.json'), 'utf8'));
const library = new (await import('../src/core/eagle-api.js')).EagleApi();
await library.assertLibrary(run.run.libraryPath);
const items = new Map(run.items.map(item => [item.id, item]));
const results = new Map(run.results.map(result => [result.unitId, result]));
const records = run.units.map(unit => {
  const members = unit.itemIds.map(id => items.get(id)).filter(Boolean);
  const primary = members.find(item => item.id === unit.primaryItemId) || members[0];
  return { ...primary, unitId: unit.id, itemIds: unit.itemIds, pairedItems: members.filter(item => item !== primary),
    ext: primary.ext, filePath: primary.filePath || primary.analysisPath || primary.thumbnailPath };
}).filter(record => record.filePath);

const byKind = record => {
  const exts = [record.ext, ...(record.pairedItems || []).map(item => item.ext)].map(x => String(x).toLowerCase());
  if (exts.includes('heic')) return 'heic';
  if (exts.some(x => ['arw', 'dng', '3fr', 'cr2', 'cr3', 'nef', 'raf', 'orf', 'rw2'].includes(x))) return 'raw-embedded-jpeg';
  return 'jpeg';
};
// Keep representation balanced while retaining the real run's formats.
const selected = [];
for (const kind of ['raw-embedded-jpeg', 'heic', 'jpeg']) {
  selected.push(...records.filter(r => byKind(r) === kind).slice(0, Math.ceil(limit / 3)));
}
selected.push(...records.filter(r => !selected.includes(r)).slice(0, Math.max(0, limit - selected.length)));
selected.splice(limit);

// Fresh exclusive directory: no deletion of existing cache roots.
const rows = [];
const timed = async (row, name, fn) => {
  const start = performance.now();
  try { const value = await fn(); row.times[name] = performance.now() - start; return value; }
  catch (error) {
    row.times[name] = performance.now() - start;
    row.errors ??= [];
    row.errors.push(`${name}: ${error.message}`);
    throw error;
  }
};
for (const record of selected) {
  const result = results.get(record.unitId) || {};
  const row = { unitId: record.unitId, kind: byKind(record), primaryExt: record.ext, times: {}, errors: [] };
  const preview = await timed(row, 'metrics.preview', () => choosePreview(record, {
    cacheDir: path.join(coldRoot, 'previews') }));
  if (preview) {
    await timed(row, 'metrics.decode-resize-indicators', () => analyzeImage({ ...record, analysisPath: preview }));
    await timed(row, 'metrics.scorer', () => score([preview], { root: process.cwd() }));
    await timed(row, 'metrics.dino', () => embedImage(preview, { cacheDir: path.join(coldRoot, 'embeddings') }));
  }
  const faces = result.faces || [];
  if (record.filePath && faces.length) {
    const maker = await timed(row, 'focus.exiftool-maker', () => readMakerFocus(record.filePath));
    await timed(row, 'focus.native-decode-extract-crops', () => withNativeImage(record,
      {}, async ({ image, source }) => {
      const buffer = await timed(row, 'focus.native-jpeg-buffer', () => image()
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer());
      row.nativeKind = source.kind;
      return analyzeFocus({ nativeBuffer: buffer, nativeSize: { width: source.width, height: source.height,
        orientation: source.orientation, rawWidth: source.rawWidth, rawHeight: source.rawHeight }, faces, makerFocus: maker });
    }));
  } else row.times['focus.skipped-no-faces'] = 0;
  row.errors = row.errors.length ? row.errors : undefined;
  rows.push(row);
  console.error(`${rows.length}/${selected.length} ${row.kind} ${record.name || record.unitId}`);
}
const percentile = (values, p) => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
};
const names = [...new Set(rows.flatMap(row => Object.keys(row.times)))];
const summary = Object.fromEntries(names.map(name => [name, { n: rows.filter(r => Number.isFinite(r.times[name])).length,
  meanMs: percentile(rows.map(r => r.times[name]), .5) == null ? null : rows.reduce((s, r) => s + (r.times[name] || 0), 0) /
    rows.filter(r => Number.isFinite(r.times[name])).length, p50Ms: percentile(rows.map(r => r.times[name]), .5),
  p90Ms: percentile(rows.map(r => r.times[name]), .9), maxMs: Math.max(...rows.map(r => r.times[name] || 0)) }]));
await library.assertLibrary(run.run.libraryPath);
const output = { runId, count: rows.length, coldRoot, rssKiB: process.resourceUsage().maxRSS, summary, rows };
await writeFile(path.join(coldRoot, 'profile.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
