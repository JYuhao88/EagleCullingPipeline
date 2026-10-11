// Numeric comparison only; no image reads or inference.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const root = path.resolve('data/cache/windows-validation');
const cpu = await read(path.join(root, 'cpu-latest.json')), dml = await read(path.join(root, 'dml-latest.json'));
const manifest = await read('test/fixtures/bench-syn-manifest.json');
const windows = {};
for (const [label, data] of [['cpu', cpu], ['dml', dml]]) {
  windows[label] = new Map();
  for (const image of manifest.images) windows[label].set(image.id, await read(path.join(data.out, `${image.id}.json`)));
}
function iou(a, b) {
  if (!a || !b) return 0;
  const area = box => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / (area(a) + area(b) - intersection || 1);
}
function match(a, b) {
  const choices = a.flatMap((x, i) => b.map((y, j) => ({ i, j, iou: iou(x.box, y.box) })))
    .filter(pair => pair.iou >= 0.5).sort((x, y) => y.iou - x.iou);
  const left = new Set(), right = new Set(), pairs = [];
  for (const pair of choices) {
    if (left.has(pair.i) || right.has(pair.j)) continue;
    left.add(pair.i); right.add(pair.j); pairs.push(pair);
  }
  return pairs;
}
const classifications = rows => JSON.stringify((rows || []).map(row => [row.ruleId, row.verdict]).sort());
const summaries = [];
for (const label of ['dml', 'mac', 'ray']) {
  const baseline = label === 'dml' ? windows.dml : new Map((await read(path.resolve('..', `w12-${label}-features.json`)))
    .results.map(row => [row.unitId, row]));
  const statistics = {}, changed = [];
  let matchedPeople = 0, unmatchedPeople = 0, reorderedPeople = 0, matchedFaces = 0, unmatchedFaces = 0;
  function add(field, a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const value = Math.abs(a - b), stat = statistics[field] ||= { count: 0, sum: 0, max: 0 };
    stat.count++; stat.sum += value; stat.max = Math.max(stat.max, value);
  }
  for (const image of manifest.images) {
    const a = baseline.get(image.id), b = windows.cpu.get(image.id);
    if (a.sha256 !== b.sha256) throw new Error('Image identity differs');
    add('topiq', a.scorer.quality, b.scorer.quality);
    const ap = a.signals?.persons || [], bp = b.signals?.persons || [], pairs = match(ap, bp);
    matchedPeople += pairs.length; unmatchedPeople += ap.length + bp.length - 2 * pairs.length;
    let crossings = 0;
    for (const { i, j } of pairs) {
      reorderedPeople += Number(i !== j);
      const x = ap[i].keypoints?.points || [], y = bp[j].keypoints?.points || [];
      for (let k = 0; k < 4; k++) add('personBox', ap[i].box[k], bp[j].box[k]);
      for (let k = 0; k < Math.min(x.length, y.length); k++) {
        add('keypointConfidence', x[k][2], y[k][2]);
        for (const threshold of [0.3, 0.5, 0.7, 0.75]) {
          crossings += Number((x[k][2] >= threshold) !== (y[k][2] >= threshold));
          if (Math.min(x[k][2], y[k][2]) >= threshold) {
            add(`keypointCoordinateBothAtLeast${threshold}`, x[k][0], y[k][0]);
            add(`keypointCoordinateBothAtLeast${threshold}`, x[k][1], y[k][1]);
          }
        }
      }
    }
    const af = a.faces || [], bf = b.faces || [], facePairs = match(af, bf);
    matchedFaces += facePairs.length; unmatchedFaces += af.length + bf.length - 2 * facePairs.length;
    for (const { i, j } of facePairs) for (let k = 0; k < 4; k++) add('faceBox', af[i].box[k], bf[j].box[k]);
    const classificationChanged = classifications(a.verdicts) !== classifications(b.verdicts);
    const evidenceChanged = JSON.stringify(a.verdicts) !== JSON.stringify(b.verdicts);
    if (crossings || classificationChanged || evidenceChanged) changed.push({ id: image.id, crossings,
      classificationChanged, evidenceChanged });
  }
  for (const stat of Object.values(statistics)) { stat.mean = stat.sum / stat.count; delete stat.sum; }
  summaries.push({ baseline: label, reference: 'Windows CPU', images: manifest.images.length,
    matchedPeople, unmatchedPeople, reorderedPeople, matchedFaces, unmatchedFaces, statistics,
    classificationChangedImages: changed.filter(row => row.classificationChanged).length,
    confidenceCrossings: changed.reduce((sum, row) => sum + row.crossings, 0), changed });
}
await writeFile(path.join(root, 'parity-details.json'), JSON.stringify({ summaries,
  methodology: 'Greedy one-to-one box IoU >=0.5; compare clipped signal coordinates; confidence gates require both sides.',
  limitation: 'Matching and confidence filters are diagnostic conventions, not independent accuracy ground truth.' }, null, 2));
console.log(JSON.stringify(summaries.map(({ changed, ...summary }) => summary)));
