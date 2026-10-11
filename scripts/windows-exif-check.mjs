// Read-only real metadata verification; only aggregate counters are emitted.
import { readFile, writeFile } from 'node:fs/promises';
import { inventory } from './windows-library.mjs';
import { enrichCaptureMetadata } from '../src/core/capture-metadata.js';
import { hashFile } from '../src/core/metrics.js';
if (process.platform !== 'win32') throw new Error('Real metadata stays on Windows');
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const summaries = [];
for (const [index, library] of config.libraries.entries()) {
  const { items, summary } = await inventory(library);
  const selected = items.slice(0, 8), before = [];
  for (const item of selected) before.push((await hashFile(item.filePath)).sha256);
  await enrichCaptureMetadata(selected);
  let mismatches = 0;
  for (const [i, item] of selected.entries()) mismatches += Number(before[i] !== (await hashFile(item.filePath)).sha256);
  summaries.push({ library: `library-${index + 1}`, sampled: selected.length,
    captureTimeAvailable: selected.filter(item => item.captureTime).length,
    deviceAvailable: selected.filter(item => item.device).length,
    sessions: new Set(selected.map(item => item.sessionId).filter(Boolean)).size,
    integrityMismatches: mismatches, inventory: summary });
}
await writeFile('data/cache/windows-validation/exif-check.json', JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries));
