import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeSignals, computeProxyMeasurements } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';

const root = process.env.EAGLE_POSE_PROBE_ROOT || 'data/cache/pose-provider';
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
  sumCoordinateDelta: 0, coordinateValues: 0, meanCoordinateDelta: 0,
  maxCoordinateDelta: 0, maxConfidenceDelta: 0, maxBoxDelta: 0, maxPersonScoreDelta: 0,
  personsIdentical: true, signalsIdentical: true, derivedSignalsIdentical: true,
  signalsDifferentImages: [], verdictsDifferentImages: [], derivedSignalDifferences: [],
  verdictsIdentical: true, actualProviders: reports.map(report => [...new Set(report.results
    .flatMap(worker => worker.predictions.map(pose => pose.provider)))]) };
for (let i = 0; i < files.length; i++) {
  const a = left[i], b = right[i];
  stats.personsIdentical &&= JSON.stringify(a.persons) === JSON.stringify(b.persons);
  if (a.persons.length !== b.persons.length) throw new Error('Person counts differ; inspect private predictions');
  for (let j = 0; j < a.persons.length; j++) {
    stats.persons++;
    stats.maxBoxDelta = Math.max(stats.maxBoxDelta, ...a.persons[j].box.map((v, k) => Math.abs(v-b.persons[j].box[k])));
    stats.maxPersonScoreDelta = Math.max(stats.maxPersonScoreDelta, Math.abs(a.persons[j].score-b.persons[j].score));
    const ap = a.persons[j].keypoints.points, bp = b.persons[j].keypoints.points;
    if (ap.length !== bp.length) throw new Error('Keypoint counts differ');
    for (let k = 0; k < ap.length; k++) {
      stats.keypoints++;
      stats.sumCoordinateDelta += Math.abs(ap[k][0]-bp[k][0]) + Math.abs(ap[k][1]-bp[k][1]);
      stats.coordinateValues += 2;
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
  const identical = JSON.stringify(signals[0]) === JSON.stringify(signals[1]);
  stats.signalsIdentical &&= identical;
  if (!identical) stats.signalsDifferentImages.push(i);
  // Diagnostic only: full signals equality above remains the acceptance criterion.
  const derivedSignals = signals.map(s => ({...s, persons: s.persons.map(({box, score, keypoints, ...measurements}) => measurements)}));
  const derived = derivedSignals.map(s => s.persons);
  const derivedIdentical = JSON.stringify(derivedSignals[0]) === JSON.stringify(derivedSignals[1]);
  stats.derivedSignalsIdentical &&= derivedIdentical;
  if (!derivedIdentical) for (let j = 0; j < derived[0].length; j++) {
    for (const key of new Set([...Object.keys(derived[0][j]), ...Object.keys(derived[1][j])])) {
      if (JSON.stringify(derived[0][j][key]) !== JSON.stringify(derived[1][j][key]))
        stats.derivedSignalDifferences.push({image: i, person: j, field: key, left: derived[0][j][key], right: derived[1][j][key]});
    }
  }
  const verdictsIdentical = JSON.stringify(evaluateRules(signals[0])) === JSON.stringify(evaluateRules(signals[1]));
  stats.verdictsIdentical &&= verdictsIdentical;
  if (!verdictsIdentical) stats.verdictsDifferentImages.push(i);
}
stats.meanCoordinateDelta = stats.sumCoordinateDelta / Math.max(1, stats.coordinateValues);
await writeFile(path.join(root, `compare-${labels.join('-')}.json`), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats));
// Raw prediction differences are diagnostic; all derived signals/verdicts remain a hard gate.
if (!stats.derivedSignalsIdentical || !stats.verdictsIdentical) process.exitCode = 1;
