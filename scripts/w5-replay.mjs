#!/usr/bin/env node
import { requireLocalSetting } from '../src/core/local-config.js';
// Read-only exact Shantou proxy replay. No model inference or Eagle writeback.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { measureCandidates, evaluateCandidateRules, CANDIDATE_CONFIG as c } from '../src/core/candidate-measurements.js';
import { gateFlags, rankGroup, suggestDecision } from '../src/core/ranking.js';
import { escapeHtml as esc } from '../src/plugin/feedback.js';

sharp.concurrency(1);
const input = process.argv[2] || '/tmp/w2-gate2-qa/final-analyze.json';
const out = process.argv[3] || '/tmp/w5-validate-qa';
await mkdir(out, { recursive: true });
const expectedLibrary = requireLocalSetting('EAGLE_LIBRARY_PATH');
const libraryInfo = await (await fetch('http://localhost:41595/api/library/info')).json();
if (libraryInfo.data?.library?.path !== expectedLibrary) throw new Error('Unexpected active Eagle library');
await writeFile(path.join(out, 'library-info.json'), JSON.stringify(libraryInfo, null, 2));
const run = JSON.parse(await readFile(input, 'utf8'));
if (run.libraryPath !== expectedLibrary) throw new Error('Unexpected cached library');
const results = (run.results || []).filter(x => /^DSC/.test(x.name));
if (results.length !== 253) throw new Error('Expected exact 253 Shantou units');
const baselineFile = '/tmp/w2-gate2-qa/proxy-sha256.json';
const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
const currentGates = new Set(run.groups.flatMap(g => (g.ranking || [])
  .filter(r => r.reasons?.includes('硬伤门槛：排在通过者之后')).map(r => r.unitId)));
const rows = [];
for (const r of results) {
  if (!r.previewPath.startsWith('/tmp/') || r.previewPath.includes('未删减')) throw new Error('Unsafe proxy path');
  const sha256 = crypto.createHash('sha256').update(await readFile(r.previewPath)).digest('hex');
  if (baseline.hashes[r.previewPath] !== sha256) throw new Error(`Changed proxy: ${r.unitId}`);
  const measurements = await measureCandidates(r.previewPath, r);
  const verdicts = evaluateCandidateRules(measurements, r.signals);
  rows.push({ unitId: r.unitId, name: r.name, previewPath: r.previewPath, sha256, measurements,
    signals: r.signals, verdicts, existingVerdicts: r.verdicts || [], flags: gateFlags(r) });
}
const ids = rows[0].verdicts.map(v => v.ruleId);
function distance(id, r) {
  const m = r.measurements;
  if (id === 'P-YD-TONAL-GRAY') return Math.max(m.tonal.range / c.tonal.warnRange,
    m.tonal.localContrast / c.tonal.warnLocal) - 1;
  if (id === 'P-YD-NONFACE-HIGHLIGHTS') return c.highlights.warnFraction - m.highlights.fraction;
  if (id === 'P-YD-BG-SEPARATION') return c.separation.warnWeakFraction - m.separation.weakFraction;
  const image = r.signals.imageMeasurements;
  const a = ['horizontal', 'vertical'].filter(axis => image[`${axis}LineConfidence`] >= c.tilt.confidence &&
    Number.isFinite(image[`${axis}TiltDegrees`]) && Math.abs(image[`${axis}TiltDegrees`]) <= c.tilt.maxDegrees)
    .map(axis => Math.abs(image[`${axis}TiltDegrees`]));
  return c.tilt.warnDegrees - Math.max(...a);
}
async function montage(list, target) {
  const cols = 4, w = 240, h = 210, tiles = [];
  for (const [i, r] of list.entries()) {
    const img = await sharp(r.previewPath).resize(w, h - 30, { fit: 'contain', background: '#222' }).png().toBuffer();
    const label = `<svg width="240" height="30"><text x="4" y="20" fill="white" font-size="13">`
      + `${i + 1}. ${esc(r.name)} ${r.verdict.verdict}</text></svg>`;
    tiles.push({ input: img, left: (i % cols) * w, top: Math.floor(i / cols) * h });
    tiles.push({ input: Buffer.from(label), left: (i % cols) * w, top: Math.floor(i / cols) * h + h - 30 });
  }
  if (!list.length) {
    const empty = '<svg width="960" height="120"><text x="20" y="70" fill="white">No triggered examples</text></svg>';
    tiles.push({ input: Buffer.from(empty), left: 0, top: 0 });
  }
  await sharp({ create: { width: cols * w, height: Math.max(120, Math.ceil(list.length / cols) * h),
    channels: 3, background: '#222' } }).composite(tiles).jpeg({ quality: 85 }).toFile(target);
}
const stats = { input, libraryPath: expectedLibrary, libraryVerified: true, baselineProxyHashFile: baselineFile,
  baselineUnchanged: rows.length, units: rows.length, generatedAt: new Date().toISOString(), rules: {} };
for (const id of ids) {
  const rr = rows.map(r => ({ ...r, verdict: r.verdicts.find(v => v.ruleId === id) }));
  const counts = Object.fromEntries(['pass','warn','violate','na'].map(s => [s, rr.filter(r => r.verdict.verdict === s).length]));
  const triggers = rr.filter(r => ['warn','violate'].includes(r.verdict.verdict));
  const controls = rr.filter(r => r.verdict.verdict === 'pass').sort((a,b) => distance(id,a) - distance(id,b));
  const dir = path.join(out, id);
  await mkdir(dir, { recursive: true });
  for (const [label, list] of [['trigger', triggers], ['near-threshold', controls]]) {
    const selected = list.slice(0,24).map(({ signals, existingVerdicts, ...r }) => r);
    await writeFile(path.join(dir, `${label}.json`), JSON.stringify(selected, null, 2));
    await montage(selected, path.join(dir, `${label}.jpg`));
    const figures = selected.map(r => `<figure><img src="file://${esc(r.previewPath)}">`
      + `<figcaption>${esc(r.name)}: ${esc(r.verdict.verdict)}<br>${esc(r.verdict.evidence)}</figcaption></figure>`);
    const html = '<!doctype html><meta charset="utf-8"><style>main{display:grid;grid-template-columns:repeat(4,1fr)}'
      + 'img{max-width:100%;height:240px;object-fit:contain}figure{margin:8px}</style>'
      + `<h1>${id} ${label}</h1><p>代理图；最多24张。${selected.length}个样例，无触发时联系表为空提示。</p>`
      + `<main>${figures.join('')}</main>`;
    await writeFile(path.join(dir, `${label}.html`), html);
  }
  stats.rules[id] = { counts, triggerRate: triggers.length / rows.length,
    triggerContact: `${id}/trigger.jpg`, controlContact: `${id}/near-threshold.jpg`,
    naReasons: Object.fromEntries([...new Set(rr.filter(r => r.verdict.verdict === 'na').map(r => r.verdict.evidence))]
      .map(reason => [reason, rr.filter(r => r.verdict.evidence === reason).length])) };
}
const review = [];
for (const r of rows) {
  const marked = currentGates.has(r.unitId);
  const warnings = r.existingVerdicts.filter(v => ['warn','violate'].includes(v.verdict));
  if (!marked && !warnings.length) continue;
  const has = re => warnings.some(v => re.test(v.ruleId));
  const reasons = [];
  if (r.flags.includes('blurry') || has(/BLUR|SHARP|FOCUS/)) reasons.push('有意动感模糊');
  if (r.flags.includes('underexposed') || has(/SHADOW/) ||
      warnings.some(v => /EXPOSURE/.test(v.ruleId) && /clippedShadows|死黑|欠曝/.test(v.evidence))) reasons.push('剪影/低调');
  if (r.flags.includes('eyes-closed') || has(/EYES|BLINK/)) reasons.push('有意闭眼');
  if (has(/CROP-HAIRLINE/)) reasons.push('紧裁头顶');
  if (has(/BACKGROUND-MERGER|LAYERS-SEPARATION/) || r.verdicts.some(v =>
    v.ruleId === 'P-YD-BG-SEPARATION' && ['warn','violate'].includes(v.verdict))) reasons.push('有意背景重合');
  if (reasons.length) review.push({ unitId:r.unitId, name:r.name, currentGate:marked, reasons });
}
const reasons = ['有意动感模糊','剪影/低调','有意闭眼','紧裁头顶','有意背景重合'];
stats.exceptionReviewHints = Object.fromEntries(reasons.map(reason => [reason,review.filter(r=>r.reasons.includes(reason)).length]));
stats.exceptionReviewUnique = review.length;
stats.exceptionCurrentGates = review.filter(r=>r.currentGate).length;
stats.currentGateUnits = rows.filter(r=>currentGates.has(r.unitId)).length;
await writeFile(path.join(out, 'exception-review.json'), JSON.stringify(review,null,2));
await writeFile(path.join(out, 'all-results.json'), JSON.stringify(rows,null,2));
await writeFile(path.join(out, 'stats.json'), JSON.stringify(stats,null,2));
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(rows.map(({ unitId, previewPath, sha256 }) =>
  ({ unitId, previewPath, sha256 })),null,2));
// Verify actual same-input group ordering with and without the experimental pixels.
const originals = new Map(run.results.map(r => [r.unitId,r]));
const measured = new Map(rows.map(r => [r.unitId,r.measurements]));
const invariant = { units:0, groups:0, rankScoreGateDecisionChanges:[], savedRankingDifferences:[] };
for (const group of run.groups) {
  if (!group.unitIds.some(id => measured.has(id))) continue;
  const before = group.unitIds.map(id => structuredClone(originals.get(id))), after = structuredClone(before);
  for (const r of after) if (measured.has(r.unitId)) {
    r.signals ??= { contractVersion:1, persons:[] };
    r.signals.imageMeasurements ??= {};
    r.signals.imageMeasurements.candidates = measured.get(r.unitId);
  }
  const a = rankGroup(before), b = rankGroup(after);
  const digest = (ranking, items) => ranking.map(entry => {
    const item = items.find(r => r.unitId === entry.unitId);
    return [entry.unitId,entry.rank,entry.score,gateFlags(item),suggestDecision(entry,item,items.length)];
  });
  if (JSON.stringify(digest(a,before)) !== JSON.stringify(digest(b,after))) invariant.rankScoreGateDecisionChanges.push(group.id);
  const ordering = ranking => ranking.map(r => [r.unitId,r.rank,r.score]);
  if (JSON.stringify(ordering(a)) !== JSON.stringify(ordering(group.ranking))) invariant.savedRankingDifferences.push(group.id);
  invariant.units += group.unitIds.filter(id => measured.has(id)).length;
  invariant.groups++;
}
await writeFile(path.join(out,'rank-invariance.json'),JSON.stringify(invariant,null,2));
if (invariant.units !== 253 || invariant.rankScoreGateDecisionChanges.length || invariant.savedRankingDifferences.length)
  throw new Error('W5 ranking replay changed scores/order/gates/decisions or failed to reproduce saved ranking');
console.log(JSON.stringify(stats,null,2));
