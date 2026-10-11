#!/usr/bin/env node
// Offline evaluation. Uses cached labels/poses only, never invokes a teacher.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { computeSignals, SIGNAL_THRESHOLDS } from '../../src/core/signals.js';
import { jointPrediction, legacyObservability } from './measure_qa.mjs';

export function summarizeCrops(rows) {
  const measured = rows.filter((r) => r.predicted !== 'na');
  const correct = measured.filter((r) => r.expected === r.predicted).length;
  const positive = rows.filter((r) => r.expected === 'crop');
  return { total: rows.length, measured: measured.length, na: rows.length-measured.length, correct,
    agreement: measured.length ? correct/measured.length : null,
    confirmedOverAll: rows.length ? correct/rows.length : null,
    truePositive: positive.filter((r) => r.predicted === 'crop').length,
    falseNegative: positive.filter((r) => r.predicted === 'safe').length,
    positiveNA: positive.filter((r) => r.predicted === 'na').length,
    falsePositive: rows.filter((r) => r.expected === 'safe' && r.predicted === 'crop').length,
    negativeNA: rows.filter((r) => r.expected === 'safe' && r.predicted === 'na').length };
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key)+1] : fallback;
  const input = arg('--input', '/tmp/w2-measure/synthetic');
  const manifest = JSON.parse(await fs.readFile(path.join(input, 'manifest.json'), 'utf8'));
  const poses = JSON.parse(await fs.readFile(path.join(input, 'raw-poses.json'), 'utf8'));
  const byId = new Map(poses.map((p) => [p.id, p]));
  const baselineSource = execFileSync('git', ['show', 'HEAD:src/core/signals.js'], { encoding: 'utf8' });
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
  const predict = (s, compute) => {
    const raw = byId.get(s.id);
    if (!raw?.available) return 'na';
    const signals = compute(raw), person = signals.persons.find((p) => p.isMain);
    if (person && !person.jointObservability) person.jointObservability = legacyObservability(person,
      (signals.source?.proxyWidth || 1)/(signals.source?.proxyHeight || 1), baseline.measurementPoints);
    return jointPrediction(person, s.queryJoint);
  };
  const rows = manifest.samples.map((s) => ({ id: s.id, source: s.sourceName, split: s.split,
    joint: s.queryJoint, expected: s.expected, filePath: s.filePath, predicted: predict(s, computeSignals),
    baseline: predict(s, baseline.computeSignals) }));
  const summaries = (data) => ({ overall: summarizeCrops(data),
    bySplit: Object.fromEntries(['calibration', 'evaluation'].map((split) =>
      [split, summarizeCrops(data.filter((r) => r.split === split))])),
    byJoint: Object.fromEntries(['wrist', 'neck', 'knee', 'ankle'].map((j) =>
      [j, summarizeCrops(data.filter((r) => r.joint === j))])) });
  // Exploratory sensitivity sweep: never present this as preregistered heldout validation.
  const sensitivity = [];
  for (const compressedShinRatio of [.4, .6, .8]) for (const neckEdgeHeads of [.15, .25, .35]) {
    const adjusted = rows.filter((r) => r.split === 'calibration').map((r) => {
      const raw = byId.get(r.id);
      return { ...r, predicted: jointPrediction(computeSignals(raw, { thresholds: { ...SIGNAL_THRESHOLDS,
        compressedShinRatio, neckEdgeHeads } }).persons.find((p) => p.isMain), r.joint) };
    });
    sensitivity.push({ compressedShinRatio, neckEdgeHeads, ...summarizeCrops(adjusted) });
  }
  const output = { version: 'joint-calibration-v3', baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'],
    { encoding: 'utf8' }).trim(), thresholds: SIGNAL_THRESHOLDS,
    before: summaries(rows.map((r) => ({ ...r, predicted: r.baseline }))), after: summaries(rows), sensitivity, rows,
    errors: rows.filter((r) => r.expected !== r.predicted), teacherCallsAdded: 0,
    limitations: [...manifest.limitations,
      'Source-isolated evaluation was inspected while developing validity guards: exploratory, not a blind independent test.',
      'NA is excluded from conditional agreement but counts unconfirmed in confirmedOverAll; never counted as safe.'] };
  await fs.writeFile(path.join(input, 'evaluation.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ before: output.before, after: output.after }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
