#!/usr/bin/env node
// Pixel crops are re-inferred; transformed source poses are retained as geometry
// provenance only and MUST NOT be substituted for end-to-end predictions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { detectPose } from '../../src/core/pose.js';

export function transformPoints(points, rect, size) {
  return points.map(([x, y, score]) => [(x * size.width - rect.left) / rect.width,
    (y * size.height - rect.top) / rect.height, score]);
}
export function boundaryRect(size, edge, position) {
  const pixel = Math.max(1, Math.min(size.height - 1, Math.round(position * size.height)));
  return { left: 0, top: edge === 'top' ? pixel : 0, width: size.width,
    height: edge === 'top' ? size.height - pixel : pixel };
}
export function truthMatch(expected, predicted) {
  if (!['crop', 'safe'].includes(expected) || !['crop', 'safe'].includes(predicted)) return null;
  return expected === predicted;
}
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));

export async function main(argv = process.argv.slice(2)) {
  sharp.concurrency(1);
  const arg = (name, value) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : value;
  const out = path.resolve(arg('--out', '/tmp/w2-measure/synthetic'));
  const input = path.resolve(arg('--input', '/tmp/w1-pose-qa'));
  const limit = Number(arg('--limit', 48));
  await fs.mkdir(out, { recursive: true });
  let manifest;
  if (argv.includes('--reuse')) manifest = await read(path.join(out, 'manifest.json'));
  else {
    const results = (await read(path.join(input, 'all-results.json'))).results;
    const raw = await read(path.join(input, 'raw-poses.json'));
    const bench = await read('data/cache/bench/syn/pose.json');
    const sourceNames = ['DSC07108', 'DSC07105', 'DSC07109', 'DSC07111'];
    const sources = [
      ...['s011', 's012'].map((name, index) => ({ name, unitId: `bench:${name}`,
        path: path.resolve(`data/cache/bench/syn/${name}.jpg`),
        pose: bench.find((r) => r.id === name), split: index ? 'evaluation' : 'calibration', legs: true })),
      ...sourceNames.map((name, index) => {
        const r = results.find((r) => r.name === name);
        return { name, unitId: r.unitId, path: r.previewPath,
          pose: raw.find((p) => p.id === r.unitId), legs: false,
          split: index % 2 ? 'evaluation' : 'calibration' };
      }),
    ];
    manifest = { version: 1,
      truth: 'source-keypoint geometric crop with visual source eligibility review',
      limitations: ['Shantou long skirts conceal knees/ankles: no leg labels created.',
        'Bench ankles are localized inside fitted boots; crop boundary is approximate.',
        'Neck boundary interpolated nose/shoulders, not a directly detected landmark.',
        'Source frames are related: heldout-by-source is not a generalization benchmark.'],
      sources: sources.map(({ name, unitId, path, split, legs }) => ({ name, unitId, path, split, legs })),
      samples: [] };
    for (const source of sources) {
      if (source.pose?.persons?.length !== 1) throw new Error(`Source must be single-person: ${source.name}`);
      const p = source.pose.persons[0];
      const points = p.keypoints.points;
      const size = await sharp(source.path).metadata();
      const neckY = points[0][1] * .35 + (points[5][1] + points[6][1]) * .325;
      const lowerWrist = points[9][1] > points[10][1] ? 9 : 10;
      const joints = { neck: { y: neckY, edge: 'top', indices: [0, 5, 6] },
        wrist: { y: points[lowerWrist][1], edge: 'bottom', indices: [lowerWrist] } };
      if (source.legs) Object.assign(joints, {
        knee: { y: points[source.name === 's012' ? 14 : 13][1], edge: 'bottom',
          indices: [source.name === 's012' ? 14 : 13] },
        ankle: { y: points[source.name === 's012' ? 16 : 15][1], edge: 'bottom',
          indices: [source.name === 's012' ? 16 : 15] },
      });
      for (const [queryJoint, joint] of Object.entries(joints)) {
        if (joint.indices.some((i) => points[i][2] < .6)) continue;
        const upperarmY = (points[5][1] + points[7][1]) / 2;
        const leg = source.name === 's012' ? 12 : 11;
        const thighY = (points[leg][1] + points[leg + 2][1]) / 2;
        for (const [variant, expected, edge, y] of [
          ['joint-minus', 'crop', joint.edge, joint.y - .004],
          ['joint-plus', 'crop', joint.edge, joint.y + .004],
          ['safe-midsegment', 'safe', 'bottom', queryJoint === 'neck' ? upperarmY : thighY],
        ]) {
          if (manifest.samples.length >= limit) break;
          const id = `${source.name}-${queryJoint}-${variant}`;
          const rect = boundaryRect(size, edge, y);
          const filePath = path.join(out, `${id}.jpg`);
          await sharp(source.path).extract(rect).jpeg({ quality: 95 }).toFile(filePath);
          manifest.samples.push({ id, sourceUnitId: source.unitId, sourceName: source.name,
            split: source.split, queryJoint, expected, edge, variant, sourceJointY: joint.y,
            sourceIndices: joint.indices, sourcePoints: joint.indices.map((i) => points[i]),
            sourceSize: { width: size.width, height: size.height }, crop: rect, filePath,
            transformedSourcePoints: transformPoints(points, rect, size) });
        }
      }
    }
    await write(path.join(out, 'manifest.json'), manifest);
  }
  const started = performance.now();
  let poses = [];
  if (!argv.includes('--prepare-only')) {
    if (argv.includes('--reuse')) poses = await read(path.join(out, 'raw-poses.json')).catch(() => []);
    const present = new Set(poses.map((p) => p.id));
    const pending = manifest.samples.filter((s) => !present.has(s.id));
    if (pending.length) {
      poses.push(...await detectPose(pending.map(({ id, filePath }) => ({ id, filePath })), { size: 1 }));
      await write(path.join(out, 'raw-poses.json'), poses);
    }
  }
  const summary = { out, sources: manifest.sources.length, samples: manifest.samples.length,
    calibration: manifest.samples.filter((s) => s.split === 'calibration').length,
    evaluation: manifest.samples.filter((s) => s.split === 'evaluation').length,
    inferred: poses.length, unavailable: poses.filter((p) => !p.available).length,
    detected: poses.filter((p) => p.persons?.length).length,
    provider: [...new Set(poses.map((p) => p.provider))], elapsedMs: performance.now() - started };
  await write(path.join(out, 'summary.json'), summary);
  console.log(JSON.stringify(summary));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
