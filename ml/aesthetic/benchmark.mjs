import { readFile, writeFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { aestheticFromEmbedding, AESTHETIC_HEAD_VERSION } from '../../src/core/aesthetic-head.js';

const [resultsPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !outputPath) throw new Error('Results and output arguments required');
if (AESTHETIC_HEAD_VERSION === 'unavailable') throw new Error('A trained head is required');
const data = JSON.parse(await readFile(resultsPath, 'utf8'));
const rows = data.results.filter(row => aestheticFromEmbedding(row.embedding, { embeddingVersion: row.embeddingVersion }) !== null);
if (!rows.length) throw new Error('No compatible cached embeddings');
const times = [];
let checksum = 0;
for (let index = 0; index < 10000; index++) {
  const row = rows[index % rows.length];
  const start = performance.now();
  checksum += aestheticFromEmbedding(row.embedding, { embeddingVersion: row.embeddingVersion });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const report = { head_version: AESTHETIC_HEAD_VERSION, iterations: times.length, compatible_rows: rows.length,
  mean_ms: times.reduce((sum, value) => sum + value, 0) / times.length,
  median_ms: times[Math.floor(times.length / 2)], p95_ms: times[Math.floor(times.length * 0.95)], max_ms: times.at(-1),
  head_bytes: (await stat(new URL('../../src/core/aesthetic-head.json', import.meta.url))).size, checksum,
  scores: rows.map(row => ({ unitId: row.unitId, aesthetic: aestheticFromEmbedding(row.embedding,
    { embeddingVersion: row.embeddingVersion }) })) };
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, scores: undefined }));
