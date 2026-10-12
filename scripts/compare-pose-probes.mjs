import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeSignals, computeProxyMeasurements } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';

const root = 'data/cache/pose-provider';
const labels = process.argv.slice(2);
if (labels.length !== 2 || labels.some(label => !/^[a-z0-9-]+$/.test(label)))
  throw new Error('Pass two private probe labels');
const reports = await Promise.all(labels.map(label => readFile(path.join(root, `${label}.json`), 'utf8').then(JSON.parse)));
if (JSON.stringify(reports[0].inputSha256) !== JSON.stringify(reports[1].inputSha256))
  throw new Error('Input digests differ');
const files = JSON.parse(await readFile(path.join(root, 'probe-inputs.json'), 'utf8'));
const flatten = report => {
  const predictions = new Array(files.length);
  report.results.forEach((worker, index) => worker.predictions.forEach((pose, row) => {
    predictions[row * report.workers + index] = pose;
  }));
  if (predictions.filter(Boolean).length !== files.length) throw new Error('Incomplete probe predictions');
  return predictions;
};
const [left, right] = reports.map(flatten);
const stats = { labels, images: files.length, persons: 0, keypoints: 0,
  maxCoordinateDelta: 0, maxConfidenceDelta: 0, personsIdentical: true, signalsIdentical: true,
  verdictsIdentical: true, actualProviders: reports.map(report => [...new Set(report.results
    .flatMap(worker => worker.predictions.map(pose => pose.provider)))]) };
for (let i = 0; i < files.length; i++) {
  const a = left[i], b = right[i];
  stats.personsIdentical &&= JSON.stringify(a.persons) === JSON.stringify(b.persons);
  if (a.persons.length !== b.persons.length) throw new Error('Person counts differ; inspect private predictions');
  for (let j = 0; j < a.persons.length; j++) {
    stats.persons++;
    const ap = a.persons[j].keypoints.points, bp = b.persons[j].keypoints.points;
    if (ap.length !== bp.length) throw new Error('Keypoint counts differ');
    for (let k = 0; k < ap.length; k++) {
      stats.keypoints++;
      stats.maxCoordinateDelta = Math.max(stats.maxCoordinateDelta,
        Math.abs(ap[k][0] - bp[k][0]), Math.abs(ap[k][1] - bp[k][1]));
      stats.maxConfidenceDelta = Math.max(stats.maxConfidenceDelta, Math.abs(ap[k][2] - bp[k][2]));
    }
  }
  const signals = [];
  for (const pose of [a, b]) {
    pose.imageMeasurements = await computeProxyMeasurements(files[i], { persons: pose.persons, faces: [] });
    signals.push(computeSignals(pose));
  }
  stats.signalsIdentical &&= JSON.stringify(signals[0]) === JSON.stringify(signals[1]);
  stats.verdictsIdentical &&= JSON.stringify(evaluateRules(signals[0])) === JSON.stringify(evaluateRules(signals[1]));
}
await writeFile(path.join(root, `compare-${labels.join('-')}.json`), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats));
