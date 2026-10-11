import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('..'), summaries = {};
for (const step of ['bench-cpu', 'bench-dml', 'ui', 'python-scorer', 'real-scale', 'real-ratings', 'release-bench']) {
  let text;
  try { text = await readFile(path.join(root, 'logs', `${step}-resources.csv`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const lines = text.trim().split(/\r?\n/), headers = lines.shift().replace(/^\uFEFF/, '').split(',');
  const rows = lines.map(line => line.split(',').map(value => value.trim()));
  const peaks = {};
  for (let i = 1; i < headers.length; i++) {
    const values = rows.map(row => Number(row[i])).filter(Number.isFinite);
    peaks[headers[i]] = values.length ? Math.max(...values) : null;
  }
  summaries[step] = { samples: rows.length, peaks };
}
const result = { samples: summaries,
  limitation: 'GPU memory is whole-device usage, including desktop and other applications; sampled peaks can miss transients.' };
await writeFile('data/cache/windows-validation/resources.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
