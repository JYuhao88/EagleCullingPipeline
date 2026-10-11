#!/usr/bin/env node
// Read-only cached-pose QA: no Eagle APIs, inference models, ranking or teacher calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { computeSignals, computeProxyMeasurements } from '../../src/core/signals.js';
import { evaluateRules } from '../../src/core/rules-engine.js';
import { POSE_SIGNALS_CACHE_KEY } from '../../src/core/pose.js';
import { validateUnitResult } from '../../src/core/contracts.js';

const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2));
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const joints = ['wrist', 'elbow', 'knee', 'ankle', 'neck', 'hairline'];
const indices = { wrist: [9, 10, 91, 112], elbow: [7, 8], knee: [13, 14], ankle: [15, 16], neck: [5, 6] };

export function legacyObservability(person, aspect, measurementPoints) {
  const points = measurementPoints(person, aspect);
  return Object.fromEntries(joints.map((joint) => [joint, joint === 'hairline'
    ? Number.isFinite(person.headHeight) && person.headHeight > 0
    : indices[joint]?.some((i) => points[i]?.slice(0, 3).every(Number.isFinite) && points[i][2] >= .3) === true]));
}

export function jointPrediction(person, joint) {
  if (person?.edgeAtJoint?.some((hit) => hit.joint === joint)) return 'crop';
  if (!person?.edgeAtJoint) return 'na';
  if (person.jointObservability) return person.jointObservability[joint] === true ? 'safe' : 'na';
  if (joint === 'hairline') return Number.isFinite(person.headHeight) ? 'safe' : 'na';
  return indices[joint]?.some((i) => person.keypoints?.points?.[i]?.[2] >= .3) ? 'safe' : 'na';
}

export function compareTeacher(labels, results) {
  const byId = new Map(results.map((r) => [r.unitId, r]));
  const rows = [];
  for (const sample of labels) {
    const main = byId.get(sample.unitId)?.signals?.persons?.find((p) => p.isMain);
    for (const joint of joints) {
      const teacher = sample.joints[joint];
      const predicted = jointPrediction(main, joint);
      rows.push({ unitId: sample.unitId, name: sample.name, joint, teacher: teacher.status, predicted,
        excluded: teacher.status === 'uncertain', measurable: predicted !== 'na',
        agreed: teacher.status !== 'uncertain' && teacher.status === predicted });
    }
  }
  const counts = (data) => {
    const definite = data.filter((r) => !r.excluded), measured = definite.filter((r) => r.measurable);
    const correct = measured.filter((r) => r.agreed).length;
    const crops = measured.filter((r) => r.teacher === 'crop');
    return { all: data.length, teacherDefinite: definite.length, teacherUncertain: data.length-definite.length,
      teacherCrops: definite.filter((r) => r.teacher === 'crop').length, measurable: measured.length,
      naOnDefinite: definite.length-measured.length, correct, agreement: measured.length ? correct/measured.length : null,
      confirmedAgreementOverDefinite: definite.length ? correct/definite.length : null,
      truePositive: crops.filter((r) => r.predicted === 'crop').length,
      falsePositive: measured.filter((r) => r.teacher === 'safe' && r.predicted === 'crop').length,
      falseNegative: crops.filter((r) => r.predicted === 'safe').length };
  };
  return { overall: counts(rows), byJoint: Object.fromEntries(joints.map((j) => [j, counts(rows.filter((r) => r.joint === j))])),
    rows, note: 'Joint-level uncertain excluded only for that joint. NA never counts as safe/agreement. No teacher positives.' };
}

export async function main(argv = process.argv.slice(2)) {
  sharp.concurrency(1);
  const arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key)+1] : fallback;
  const input = arg('--input', '/tmp/w1-pose-qa'), teacher = arg('--teacher', '/tmp/w2-measure/teacher');
  const out = arg('--out', '/tmp/w2-measure-qa');
  await fs.mkdir(out, { recursive: true });
  const old = await read(path.join(input, 'all-results.json')), poses = await read(path.join(input, 'raw-poses.json'));
  const labels = await read(path.join(teacher, 'labels.json')), poseMap = new Map(poses.map((p) => [p.id, p]));
  const baselineSource = execFileSync('git', ['show', 'HEAD:src/core/signals.js'], { encoding: 'utf8' });
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
  const baselineResults = old.results.map((r) => {
    const raw = poseMap.get(r.unitId), signals = baseline.computeSignals(raw);
    for (const p of signals.persons) p.jointObservability = legacyObservability(p,
      (signals.source?.proxyWidth || 1)/(signals.source?.proxyHeight || 1), baseline.measurementPoints);
    return { ...r, signals };
  });
  const callsBefore = await fs.readFile(path.join(teacher, 'calls.json'));
  const fingerprints = {}, results = [], distributions = {}, started = performance.now();
  for (const row of old.results) {
    const raw = poseMap.get(row.unitId);
    if (!raw) throw new Error(`Missing saved pose ${row.unitId}`);
    fingerprints[row.previewPath] = hash(await fs.readFile(row.previewPath));
    let imageMeasurements, measurementError;
    try { imageMeasurements = await computeProxyMeasurements(row.previewPath, { faces: row.faces, persons: raw.persons }); }
    catch (error) { measurementError = error.message; }
    const signals = computeSignals({ ...raw, imageMeasurements });
    const verdicts = evaluateRules(signals, { faces: row.faces });
    const result = { ...row, signals, verdicts, pose: { ...row.pose, cacheKey: POSE_SIGNALS_CACHE_KEY,
      reusedKeypoints: true, coordinates: 'clamped-W1' }, ...(measurementError ? { measurementError } : {}) };
    if (!validateUnitResult(result)) throw new Error(`Invalid UnitResult ${row.unitId}`);
    results.push(result);
    for (const v of verdicts) {
      distributions[v.ruleId] ??= { pass: 0, warn: 0, violate: 0, na: 0, units: new Set() };
      distributions[v.ruleId][v.verdict]++;
      if (['warn', 'violate'].includes(v.verdict)) distributions[v.ruleId].units.add(row.unitId);
    }
  }
  for (const [file, before] of Object.entries(fingerprints)) {
    if (hash(await fs.readFile(file)) !== before) throw new Error(`Proxy changed during read-only QA ${file}`);
  }
  if (hash(callsBefore) !== hash(await fs.readFile(path.join(teacher, 'calls.json')))) throw new Error('Teacher ledger changed');
  const teacherReport = { before: compareTeacher(labels, baselineResults), after: compareTeacher(labels, results) };
  await write(path.join(out, 'teacher-comparison.json'), teacherReport);
  const requests = new Map();
  for (const row of teacherReport.after.rows.filter((r) => r.excluded && r.predicted === 'crop')) {
    const result = results.find((r) => r.unitId === row.unitId);
    if (!requests.has(row.unitId)) requests.set(row.unitId, { unitId: row.unitId, name: row.name,
      previewPath: result.previewPath, teacherUncertainJoints: [], request: 'Locate actual anatomical joint/frame intersection.' });
    requests.get(row.unitId).teacherUncertainJoints.push(row.joint);
  }
  await write(path.join(out, 'supplementary-label-requests.json'), [...requests.values()]);
  await write(path.join(out, 'all-results.json'), { summary: { total: results.length }, results });
  await write(path.join(out, 'proxy-sha256.json'), fingerprints);
  const libraries = await Promise.all((await fs.readdir('src/rules')).filter((f) => f.endsWith('.json'))
    .map((f) => read(path.join('src/rules', f))));
  const configured = libraries.flatMap((l) => l.rules.filter((r) => r.check.measure).map((r) => r.id));
  const summary = { total: results.length, elapsedMs: performance.now()-started, proxyReadOnlyVerified: true,
    teacherCallsAdded: 0, teacherLedgerSha256: hash(callsBefore), measurementVersion: 'measure-v3', configured,
    imageMeasureErrors: results.filter((r) => r.measurementError).map((r) => ({ name: r.name, error: r.measurementError })),
    distribution: Object.fromEntries(Object.entries(distributions).map(([id, { units, ...counts }]) =>
      [id, { ...counts, triggeredUnits: units.size }])),
    teacherBefore: teacherReport.before.overall, teacherAfter: teacherReport.after.overall,
    limitation: 'Reuses W1 clamped poses. No re-inference; default emits all genre branches as technical diagnostics.' };
  await write(path.join(out, 'summary.json'), summary);
  // Include corrected W1 false positives and a diverse set of image-rule warnings.
  const chosen = [], add = (r) => { if (r && !chosen.includes(r) && chosen.length < 10) chosen.push(r); };
  for (const name of ['DSC07070', 'DSC07091', 'DSC07118']) add(results.find((r) => r.name === name));
  for (const id of ['P-EXPOSURE-INTENT', 'G-PROXY-BLUR', 'L-HORIZON-LEVEL', 'L-VERTICAL-LEVEL',
    'P-COLOR-CAST', 'L-EXPOSURE-DETAIL', 'L-SHADOW-RECOVERY', 'G-EDGE-GRADIENT', 'P-SUBJECT-PLACEMENT']) {
    add(results.find((r) => !chosen.includes(r) && r.verdicts.some((v) => v.ruleId === id && v.verdict === 'warn')));
  }
  for (const r of results) add(r);
  const composites = [], tileWidth = 420, tileHeight = 580;
  const xml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  for (const [index, r] of chosen.entries()) {
    const image = await sharp(r.previewPath).resize(400, 450, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
    const ox = (tileWidth-image.info.width)/2, oy = 35;
    let svg = `<text x="10" y="22" fill="white" font-size="18">${index+1}. ${xml(r.name)}</text>`;
    const main = r.signals.persons.find((p) => p.isMain);
    if (main) {
      const [x0, y0, x1, y1] = main.box;
      svg += `<rect x="${ox+x0*image.info.width}" y="${oy+y0*image.info.height}" ` +
        `width="${(x1-x0)*image.info.width}" height="${(y1-y0)*image.info.height}" fill="none" stroke="#00ff55"/>`;
    }
    svg += `<rect x="${ox}" y="${oy}" width="${image.info.width}" height="${image.info.height}" ` +
      'fill="none" stroke="orange"/>';
    const warningText = r.verdicts.filter((v) => ['warn', 'violate'].includes(v.verdict))
      .slice(0, 4).map((v) => `${v.ruleId}: ${v.verdict}`);
    if (!warningText.length) warningText.push('Proxy hints pass / joint visibility NA');
    for (const [i, label] of warningText.entries()) {
      svg += `<text x="10" y="${500+18*i}" fill="white" font-size="14">${xml(label)}</text>`;
    }
    const tile = await sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background: '#222' } })
      .composite([{ input: image.data, left: Math.round(ox), top: oy },
        { input: Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}">${svg}</svg>`), left: 0, top: 0 }])
      .jpeg().toBuffer();
    composites.push({ input: tile, left: (index%5)*tileWidth, top: Math.floor(index/5)*tileHeight });
  }
  await sharp({ create: { width: tileWidth*5, height: tileHeight*2, channels: 3, background: '#222' } })
    .composite(composites).jpeg({ quality: 90 }).toFile(path.join(out, 'contact-10.jpg'));
  await write(path.join(out, 'examples.json'), chosen.map((r) => ({ unitId: r.unitId, name: r.name,
    previewPath: r.previewPath, signals: r.signals, verdicts: r.verdicts })));
  console.log(JSON.stringify(summary));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
