import { readFile, writeFile } from 'node:fs/promises';
import { computeSignals, computeProxyMeasurements } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';

const [leftPath, rightPath, outputPath] = process.argv.slice(2);
if (!leftPath || !rightPath || !outputPath) throw new Error('usage: ... left.json right.json output.json');
const [left, right] = await Promise.all([leftPath, rightPath].map(p => readFile(p, 'utf8').then(JSON.parse)));
if (left.length !== right.length) throw new Error('provider result lengths differ');
const report = { images: left.length, signalsDifferent: 0, verdictsDifferent: 0, derived: [] };
for (let i = 0; i < left.length; i++) {
  const [a, b] = [left[i], right[i]];
  const derived = [];
  for (const pose of [a, b]) {
    pose.imageMeasurements = await computeProxyMeasurements(pose.filePath, { persons: pose.persons || [], faces: [] });
    const signals = computeSignals(pose);
    const verdicts = evaluateRules(signals);
    for (const person of signals.persons || []) {
      delete person.keypoints;
      delete person.box;
      delete person.score;
    }
    derived.push({ signals, verdicts });
  }
  const signalsSame = JSON.stringify(derived[0].signals) === JSON.stringify(derived[1].signals);
  const verdictsSame = JSON.stringify(derived[0].verdicts) === JSON.stringify(derived[1].verdicts);
  if (!signalsSame) report.signalsDifferent++;
  if (!verdictsSame) report.verdictsDifferent++;
  report.derived.push({ id: a.id, signalsSame, verdictsSame });
}
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ images: report.images, signalsDifferent: report.signalsDifferent,
  verdictsDifferent: report.verdictsDifferent }));
