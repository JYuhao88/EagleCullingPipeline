#!/usr/bin/env node
// Real RGB patterns exercise proxy measurement through PNG decode and rule evaluation.
// They establish technical sensitivity, not natural-photo intent or aesthetic cutoffs.
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { computeProxyMeasurements, computeSignals } from '../../src/core/signals.js';
import { evaluateRules } from '../../src/core/rules-engine.js';

export function syntheticPatterns(size = 512) {
  const fill = (fn) => {
    const rgb = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const pixel = fn(x, y);
      for (let channel = 0; channel < 3; channel++) rgb[(y * size + x) * 3 + channel] = pixel[channel];
    }
    return rgb;
  };
  const gray = (value) => [value, value, value];
  const solid = (value) => fill(() => Array.isArray(value) ? value : gray(value));
  const patterns = [];
  const add = (name, truth, rgb, options = {}) => patterns.push({ name, truth, rgb, size, ...options });
  const person = { box: [.1, .05, .9, .95], isMain: true, score: .99 };
  const face = { box: [.35, .2, .65, .45] };
  add('neutral-gray', { family: 'neutral', level: 128 }, solid(128));
  for (const level of [0, 3, 4, 15, 251, 252, 255])
    add(`endpoint-${level}`, { family: 'endpoint', level }, solid(level));
  for (const rgb of [[128, 128, 128], [160, 128, 128], [180, 128, 128], [210, 128, 128]])
    add(`cast-${rgb.join('-')}`, { family: 'color', channelLevels: rgb }, solid(rgb));
  const texture = fill((x, y) => gray((Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? 220 : 35));
  add('texture-clear', { family: 'blur', degradation: 'none' }, texture);
  for (const sigma of [1, 3, 8])
    add(`texture-gaussian-${sigma}`, { family: 'blur', degradation: 'gaussian', sigmaPixels: sigma }, texture, { blur: sigma });
  for (const radius of [3, 12, 30]) {
    const motion = Buffer.alloc(texture.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++)
        sum += texture[(y * size + Math.max(0, Math.min(size - 1, x + dx))) * 3];
      const level = Math.round(sum / (radius * 2 + 1));
      for (let channel = 0; channel < 3; channel++) motion[(y * size + x) * 3 + channel] = level;
    }
    add(`texture-motion-${radius}`, { family: 'blur', degradation: 'horizontal-box', radiusPixels: radius }, motion);
  }
  for (const axis of ['horizontal', 'vertical']) for (const degrees of [0, 3, 8]) {
    const slope = Math.tan(degrees * Math.PI / 180);
    const rgb = fill((x, y) => {
      const u = axis === 'horizontal' ? x : y, v = axis === 'horizontal' ? y : x;
      const onLine = [.22, .42, .62, .82].some((anchor) => Math.abs(v - anchor * size - slope * (u - size / 2)) < 2);
      return gray(onLine ? 240 : 40);
    });
    add(`${axis}-${degrees}`, { family: 'geometry', axis, degrees }, rgb);
  }
  const mildTexture = (x, y) => gray(120 + ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 8);
  add('edge-control', { family: 'edge', borderTexture: false }, fill(mildTexture));
  add('edge-strong', { family: 'edge', borderTexture: true }, fill((x, y) => {
    const border = Math.min(x, y, size - 1 - x, size - 1 - y) < Math.round(size * .06);
    return border ? gray((Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 235 : 20) : mildTexture(x, y);
  }));
  const insideFace = (x, y) => x >= face.box[0] * size && x < face.box[2] * size &&
    y >= face.box[1] * size && y < face.box[3] * size;
  for (const [name, inLevel, outLevel] of [
    ['face-neutral-outside-white', 128, 255], ['face-white-outside-neutral', 255, 128],
    ['face-dark-outside-neutral', 8, 128],
  ]) add(name, { family: 'face', inLevel, outLevel }, fill((x, y) => gray(insideFace(x, y) ? inLevel : outLevel)),
    { persons: [person], faces: [face] });
  add('face-small', { family: 'face', tooSmall: true }, solid(255),
    { persons: [person], faces: [{ box: [.4, .25, .405, .255] }] });
  add('face-unknown', { family: 'face', missing: true }, solid(255), { persons: [person], faces: [] });
  add('subject-small', { family: 'subject', area: 'small' }, solid(128),
    { persons: [{ box: [.45, .45, .55, .55], isMain: true }] });
  add('subject-center', { family: 'subject', area: 'large', placement: 'center' }, solid(128), { persons: [person] });
  return patterns;
}

export async function measurePattern(pattern, out) {
  const filePath = path.join(out, `${pattern.name}.png`);
  let encoder = sharp(pattern.rgb, { raw: { width: pattern.size, height: pattern.size, channels: 3 } });
  if (pattern.blur) encoder = encoder.blur(pattern.blur);
  await encoder.png().toFile(filePath);
  const persons = pattern.persons || [], faces = pattern.faces || [];
  const imageMeasurements = await computeProxyMeasurements(filePath, { faces, persons });
  const signals = computeSignals({ width: pattern.size, height: pattern.size, persons, imageMeasurements });
  return { name: pattern.name, truth: pattern.truth, filePath, imageMeasurements, persons: signals.persons,
    verdicts: evaluateRules(signals) };
}

export function calibrationSummary(results) {
  const general = JSON.parse(readFileSync(new URL('../../src/rules/general.json', import.meta.url), 'utf8'));
  const blurThreshold = general.rules.find((rule) => rule.id === 'G-PROXY-BLUR').check.measure.conditions[0].threshold;
  const find = (name) => results.find((row) => row.name === name);
  const metric = (name, field) => find(name)?.imageMeasurements[field];
  const blur = results.filter((row) => row.truth.family === 'blur').map((row) =>
    ({ name: row.name, variance: row.imageMeasurements.laplacianVariance,
      verdict: row.verdicts.find((v) => v.ruleId === 'G-PROXY-BLUR')?.verdict }));
  const geometry = results.filter((row) => row.truth.family === 'geometry').map((row) =>
    ({ name: row.name, expectedDegrees: row.truth.degrees,
      measuredDegrees: row.imageMeasurements[`${row.truth.axis}TiltDegrees`],
      confidence: row.imageMeasurements[`${row.truth.axis}LineConfidence`] }));
  const recommendations = {
    histogram: 'Endpoint boundaries confirmed at max RGB >=252 and luminance <=3; region fractions remain intent-dependent warnings.',
    face: 'Face shadow luminance <=15 is independent of global <=3; subject inner-face region requires >=64 pixels and >=8px axes.',
    color: { control: metric('cast-160-128-128', 'grayWorldDeviation'),
      degraded: metric('cast-180-128-128', 'grayWorldDeviation'), currentThreshold: .25,
      suggestedTechnicalInterval: [.2, .2889], limitation: 'Gray-world cannot distinguish lighting or scene color from unwanted cast.' },
    blur: { currentThreshold: blurThreshold, results: blur,
      suggestedTechnicalInterval: { lowerExclusive: metric('texture-motion-30', 'laplacianVariance'),
        upperInclusive: metric('texture-gaussian-1', 'laplacianVariance') },
      suggestedThreshold: 200,
      missesAtCurrentThreshold: ['texture-gaussian-3', 'texture-gaussian-8', 'texture-motion-12', 'texture-motion-30']
        .filter((name) => find(name).verdicts.find((v) => v.ruleId === 'G-PROXY-BLUR')?.verdict !== 'warn'),
      limitation: 'Texture and directional motion matter; a global proxy variance cannot establish blur type or photographic intent.' },
    edge: { control: metric('edge-control', 'edgeGradientRatio'), degraded: metric('edge-strong', 'edgeGradientRatio'),
      currentThreshold: 2, limitation: 'Strong boundary texture can be intentional framing.' },
    tilt: { horizontalThreshold: 2, verticalThreshold: 3, results: geometry,
      limitation: 'Line consensus establishes geometry only; semantics and perspective remain unknown.' },
    subject: 'Area <.02 and anchor distance >.25 are unlabelled composition heuristics; retain hint/warn.',
  };
  return { version: 'measure-calibration-v1', cases: results.length, proxySize: 512,
    noTeacherCalls: true, recommendations, note: 'Synthetic RGB truth; no natural-image quality labels.' };
}

export async function runCalibration(out) {
  await mkdir(out, { recursive: true });
  const start = performance.now(), results = [];
  for (const pattern of syntheticPatterns()) results.push(await measurePattern(pattern, out));
  const summary = { ...calibrationSummary(results), elapsedMs: Math.round(performance.now() - start) };
  await writeFile(path.join(out, 'measurements.json'), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : '/tmp/w2-measure/calibration';
  if (!out) throw new Error('--out requires a directory');
  const summary = await runCalibration(path.resolve(out));
  console.log(JSON.stringify({ out, cases: summary.cases, elapsedMs: summary.elapsedMs }));
}
