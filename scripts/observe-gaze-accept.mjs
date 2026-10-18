#!/usr/bin/env node
// Research acceptance calls production feature and head functions; it never writes a shipped head.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadObservationHeads, observationsFromVector } from '../src/core/observation-head.js';
import { observationFaceCrop, observationFeatureVector } from '../src/core/observation-runtime.js';
import { closeGazeGeometryWorker } from '../src/core/gaze-geometry.js';

const root = process.cwd();
const rows = JSON.parse(await readFile('accept-manifest.json', 'utf8'));
const [entry] = await loadObservationHeads({ root, directory: path.join(root, 'accept-heads') });
if (!entry) throw new Error('Acceptance head or assets unavailable');
await mkdir('output/crops', { recursive: true });
const features = [], started = performance.now();
let valid = 0;
if (process.argv.includes('--score-only')) {
  const records = (await readFile('output/runtime-features.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
  const boxes = new Map(rows.map(row => [row.id, row.box]));
  for (const row of records) {
    row.items = observationsFromVector(row.features, entry.head, { box: boxes.get(row.id) });
    features.push(row);
  }
} else {
  try {
    for (const [index, row] of rows.entries()) {
      let file = row.file, vector = null;
      if (row.source) {
        file = `output/crops/${row.id}.png`;
        const crop = await observationFaceCrop(() => sharp(row.source).rotate(row.rotation || 0),
          row.sourceSize, row.box);
        if (!crop) throw new Error('Invalid acceptance crop');
        await writeFile(file, crop);
      }
      if (file && row.box?.[3] - row.box?.[1] >= entry.head.input.minFaceHeight)
        vector = await observationFeatureVector(file, entry);
      const items = observationsFromVector(vector, entry.head, { box: row.box });
      if (vector) valid++;
      features.push({ id: row.id, features: vector, items, ...(file ? { file } : {}) });
      if ((index + 1) % 100 === 0 || index + 1 === rows.length)
        console.log('PROBE_REPORT ' + JSON.stringify({ stage: 'node-accept', completed: index + 1,
          total: rows.length, valid, elapsed: (performance.now() - started) / 1000 }));
    }
  } finally { closeGazeGeometryWorker(); }
}
await writeFile('output/runtime-features.jsonl', features.map(row => JSON.stringify(row)).join('\n') + '\n');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
await writeFile('output/node-versions.json', JSON.stringify({ node: process.version,
  sharp: sharp.versions, onnxruntime: require('onnxruntime-node/package.json').version,
  headSha256: createHash('sha256').update(JSON.stringify(entry.head)).digest('hex') }));
