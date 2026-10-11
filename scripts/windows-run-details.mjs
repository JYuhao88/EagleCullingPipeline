// Aggregate native-format coverage only; real paths/pixels remain on Windows.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { RunStore } from '../src/server/run-store.js';
if (process.platform !== 'win32') throw new Error('Windows validation only');
const root = path.resolve('data/windows-test');
const store = new RunStore(path.join(root, 'runs'));
const summaries = [];
for (const label of ['library-1-1500', 'library-2-1500', 'library-1-ratings-500']) {
  let id;
  try { ({ id } = JSON.parse(await readFile(path.join(root, label, 'run-id.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const state = await store.get(id);
  if (state.run.status !== 'completed') continue;
  const items = new Map(state.items.map(item => [item.id, item]));
  const results = new Map(state.results.map(result => [result.unitId, result]));
  const formats = {};
  for (const unit of state.units) {
    const item = items.get(unit.primaryItemId), result = results.get(unit.id);
    const ext = item?.ext || 'unknown';
    const coverage = formats[ext] ||= { units: 0, faceUnits: 0, focusOk: 0, focusNa: 0, focusAbsent: 0, sourceKinds: {} };
    coverage.units++;
    coverage.faceUnits += Number(Boolean(result?.faces?.length));
    if (result?.focus?.status === 'ok') coverage.focusOk++;
    else if (result?.focus?.status === 'na') coverage.focusNa++;
    else coverage.focusAbsent++;
    const kind = result?.source?.kind || 'not-recorded';
    coverage.sourceKinds[kind] = (coverage.sourceKinds[kind] || 0) + 1;
  }
  summaries.push({ label, formats,
    limitation: 'No-face units may skip focus; missing source kind is not decode failure; paired RAW may supply native pixels.' });
}
await writeFile(path.join(root, 'format-coverage.json'), JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries));
