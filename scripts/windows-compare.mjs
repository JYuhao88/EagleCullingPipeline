import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const root = path.resolve('data/cache/windows-validation');
const cpu = await read(path.join(root, 'cpu-latest.json'));
const gpu = await read(path.join(root, 'dml-latest.json'));
const manifest = await read('test/fixtures/bench-syn-manifest.json');
const aggregates = {}, differences = [];
const cross = [];
for (const label of ['mac', 'ray']) {
  const baseline = await read(path.resolve('..', `w12-${label}-features.json`));
  if (baseline.manifestSha256 !== cpu.report.manifestSha256) throw new Error('Feature manifest mismatch');
  const numeric = {}, changed = [];
  for (const before of baseline.results) {
    const after = await read(path.join(cpu.out, `${before.unitId}.json`));
    if (before.sha256 !== after.sha256) throw new Error('Feature image identity mismatch');
    const values = [];
    function walk(a, b, key = '') {
      if (Number.isFinite(a) && Number.isFinite(b)) values.push({ key, difference: Math.abs(a - b), a, b });
      else if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of Object.keys(a)) if (k in b) walk(a[k], b[k], `${key}.${k}`);
      }
    }
    walk(before.metrics, after.metrics, 'metrics');
    walk(before.faces, after.faces, 'faces');
    walk(before.signals, after.signals, 'signals');
    for (const value of values) {
      const field = value.key.startsWith('faces') ? 'face' : value.key.startsWith('metrics') ? value.key :
        /keypoints.points.*\.2$/.test(value.key) ? 'keypointConfidence' : 'signalsOther';
      const row = numeric[field] ||= { count: 0, sum: 0, max: 0 };
      row.count++; row.sum += value.difference; row.max = Math.max(row.max, value.difference);
    }
    const crossings = values.filter(v => /keypoints.points.*\.2$/.test(v.key) &&
      [0.3, 0.5, 0.7, 0.75].some(t => (v.a >= t) !== (v.b >= t)));
    if (JSON.stringify(before.verdicts) !== JSON.stringify(after.verdicts) || crossings.length) {
      changed.push({ id: before.unitId, confidenceCrossings: crossings,
        verdictsChanged: JSON.stringify(before.verdicts) !== JSON.stringify(after.verdicts) });
    }
  }
  for (const row of Object.values(numeric)) { row.mean = row.sum / row.count; delete row.sum; }
  cross.push({ baseline: label, numeric, changed });
}
function number(name, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  const row = aggregates[name] ||= { count: 0, sumAbsolute: 0, maxAbsolute: 0 };
  row.count++;
  row.sumAbsolute += Math.abs(a - b);
  row.maxAbsolute = Math.max(row.maxAbsolute, Math.abs(a - b));
}
function points(name, a = [], b = []) {
  if (a.length !== b.length) return;
  for (let i = 0; i < a.length; i++) {
    if (!Array.isArray(a[i])) { number(name, a[i], b[i]); continue; }
    for (let j = 0; j < a[i].length; j++) number(`${name}.${j === 2 ? 'confidence' : 'coordinate'}`, a[i][j], b[i]?.[j]);
  }
}
for (const image of manifest.images) {
  const a = await read(path.join(cpu.out, `${image.id}.json`));
  const b = await read(path.join(gpu.out, `${image.id}.json`));
  number('topiq', a.scorer.quality, b.scorer.quality);
  let thresholds = 0;
  const ap = a.pose.persons || [], bp = b.pose.persons || [];
  if (ap.length === bp.length) for (let i = 0; i < ap.length; i++) {
    points('personBox', ap[i].box, bp[i].box);
    points('keypoint', ap[i].keypoints?.points, bp[i].keypoints?.points);
    for (let j = 0; j < (ap[i].keypoints?.points || []).length; j++) {
      const x = ap[i].keypoints.points[j]?.[2], y = bp[i].keypoints.points[j]?.[2];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        thresholds += [0.3, 0.5, 0.7, 0.75].filter(t => (x >= t) !== (y >= t)).length;
      }
    }
  }
  if (a.faces.length === b.faces.length) for (let i = 0; i < a.faces.length; i++) {
    points('faceBox', a.faces[i].box, b.faces[i].box);
    number('blink', a.faces[i].blinkLeft, b.faces[i].blinkLeft);
    number('blink', a.faces[i].blinkRight, b.faces[i].blinkRight);
  }
  const changed = { id: image.id, personCountChanged: ap.length !== bp.length,
    faceCountChanged: a.faces.length !== b.faces.length, confidenceThresholdCrossings: thresholds,
    flagsChanged: JSON.stringify(a.flags) !== JSON.stringify(b.flags),
    verdictsChanged: JSON.stringify(a.verdicts) !== JSON.stringify(b.verdicts) };
  if (Object.entries(changed).some(([key, value]) => key !== 'id' && Boolean(value))) differences.push(changed);
}
for (const row of Object.values(aggregates)) { row.meanAbsolute = row.sumAbsolute / row.count; delete row.sumAbsolute; }
const python = await read(path.join(root, 'python-scorer/summary.json'));
const nodePython = {};
for (const [mode, provider, record] of [['cpu', 'CPUExecutionProvider', cpu], ['dml', 'DmlExecutionProvider', gpu]]) {
  const values = [];
  for (const row of python[provider].rows) {
    const node = await read(path.join(record.out, `${row.id}.json`));
    values.push(Math.abs(node.scorer.quality - row.quality));
  }
  nodePython[mode] = { maxAbsolute: Math.max(...values), meanAbsolute: values.reduce((a, b) => a + b, 0) / values.length };
}
const result = { python, nodePython, aggregates, changedImages: differences.length, differences,
  cpu: cpu.report, gpu: gpu.report, crossPlatform: cross,
  limitation: 'Person/face arrays compared by prediction order only when counts match; no independent human labels.' };
await writeFile(path.join(root, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ aggregates, changedImages: differences.length }));
