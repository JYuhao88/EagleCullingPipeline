#!/usr/bin/env node
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { withNativeImage } from '../src/core/native-image.js';
import { mapProxyBoxToNative } from '../src/core/focus.js';
import { alignedPixelsJpegRoi } from '../src/core/focus-jpeg-roi.js';
import { EagleApi } from '../src/core/eagle-api.js';

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 10 });
const runId = 'run-1791589678002';
const run = JSON.parse(await readFile(`data/runs/${runId}/results.json`, 'utf8'));
const items = new Map(run.items.map(item => [item.id, item]));
const units = new Map(run.units.map(unit => [unit.id, unit]));
const sourceRows = run.results.filter(result => result.faces?.length).map(result => {
  const unit = units.get(result.unitId), primary = items.get(unit.primaryItemId);
  return { result, record: { ...primary,
    pairedItems: unit.itemIds.filter(id => id !== primary.id).map(id => items.get(id)) } };
});
const selected = [...sourceRows.filter(x => x.record.ext === 'heic').slice(0, 2),
  ...sourceRows.filter(x => x.record.ext === 'jpg' && x.record.width * x.record.height < 10_000_000).slice(0, 6),
  ...sourceRows.filter(x => x.record.ext === 'jpg' && x.record.width * x.record.height >= 10_000_000).slice(0, 12)];
const eagle = new EagleApi();
await eagle.assertLibrary(run.run.libraryPath);
await mkdir('data/cache/w23-decode', { recursive: true });
const directory = await mkdtemp('data/cache/w23-decode/aligned-pixels-');
const rows = [];
for (const { result, record } of selected) {
  const outcome = await withNativeImage(record, {}, async ({ image, source }) => {
    const pixels = await image().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const full = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
    const rois = [{ left: 1, top: 3, width: 31, height: 27 },
      { left: source.width - 17, top: source.height - 19, width: 17, height: 19 },
      { left: 0, top: 13, width: 29, height: 23 },
      ...result.faces.map(face => mapProxyBoxToNative(face.box, source))];
    for (const face of result.faces) {
      for (const eye of face.eyeBoxes || face.eyes || []) {
        const box = eye.box || eye;
        if (Array.isArray(box)) rois.push(mapProxyBoxToNative(box, source));
      }
    }
    const checks = [];
    for (const roi of rois.filter(Boolean)) {
      const expected = await sharp(full).extract(roi).raw().toBuffer();
      const actual = (await alignedPixelsJpegRoi(pixels, source, roi)).data;
      const differences = [];
      let count = 0, maxAbs = 0;
      for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) {
        count++; maxAbs = Math.max(maxAbs, Math.abs(expected[i] - actual[i]));
        if (differences.length < 16) differences.push({ x: Math.floor(i / 3) % roi.width,
          y: Math.floor(i / (3 * roi.width)), channel: i % 3, a: expected[i], b: actual[i] });
      }
      checks.push({ roi, equal: expected.equals(actual), bytes: expected.length,
        differingChannels: count, maxAbs, firstDifferences: differences });
    }
    return { source, checks };
  });
  rows.push({ unitId: result.unitId, name: record.name, outcome });
  console.error(`${rows.length}/${selected.length} ${record.name}: ${outcome.checks?.every(x => x.equal) ?? outcome.naReason}`);
  global.gc?.();
}
await eagle.assertLibrary(run.run.libraryPath);
const report = { runId, rows, nodeMaxRssKiB: process.resourceUsage().maxRSS,
  comparisons: rows.reduce((sum, row) => sum + (row.outcome.checks?.length || 0), 0),
  allPixelsEqual: rows.every(row => !row.outcome.checks || row.outcome.checks.every(check => check.equal)) };
await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, comparisons: report.comparisons, allPixelsEqual: report.allPixelsEqual }, null, 2));
if (!report.allPixelsEqual) process.exitCode = 1;
