#!/usr/bin/env node
import { requireLocalSetting } from '../src/core/local-config.js';
// Cache-only simulated users. Hundreds of actions are NOT hundreds of independent photoshoots.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rankGroup } from '../src/core/ranking.js';
import { fitPreferenceHead, preferenceVector, FEATURE_KEYS, scorePreferenceHead,
  driftReport, evaluatePreferenceHead } from '../src/core/preference-head.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
export function randomGenerator(seed = 42) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function hiddenUtility(feature, style = 'dark-tight') {
  const vector = preferenceVector(feature);
  const value = name => vector[FEATURE_KEYS.indexOf(name)];
  const direction = style === 'dark-tight' ? -1 : 1;
  return 0.2 * value('quality') + 0.15 * value('sharpness') +
    direction * 4 * value('brightness') - direction * 3 * value('cropTightness') + 3 * value('eyes');
}
function winner(candidates, style) {
  return [...candidates].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) ||
    hiddenUtility(b.feature, style) - hiddenUtility(a.feature, style) ||
    a.hash.localeCompare(b.hash))[0].hash;
}
function baselineWinner(candidates) {
  return [...candidates].sort((a, b) => (a.baselineRank ?? 0) - (b.baselineRank ?? 0) ||
    b.baselineScore - a.baselineScore || a.hash.localeCompare(b.hash))[0].hash;
}
export function simulateGroups(pool, { count = 200, seed = 42, style = 'dark-tight', dayOffset = 0,
  bulkFraction = 0.1 } = {}) {
  if (!pool.length) throw new Error('No cached multi-candidate groups');
  const random = randomGenerator(seed);
  return Array.from({ length: count }, (_, index) => {
    const source = pool[Math.floor(random() * pool.length)];
    // Subsets model repeated comparisons within a cached burst, not new independent groups.
    const shuffled = [...source.candidates].map(candidate => ({ candidate, key: random() }))
      .sort((a, b) => a.key - b.key).map(row => row.candidate);
    const candidates = shuffled.slice(0, Math.min(shuffled.length, 2 + Math.floor(random() * 4)));
    const ai = baselineWinner(candidates), preferred = winner(candidates, style);
    const bulk = random() < bulkFraction;
    return { id: `sim:${seed}:${index}`, sourceGroup: source.id, runId: 'simulation', profileId: style,
      time: new Date(Date.UTC(2026, 0, 1) + (dayOffset + index) * 86400000).toISOString(), candidates,
      winners: [bulk ? ai : preferred], signal: bulk ? 'bulk' : preferred !== ai ? 'corrected' : 'explicit',
      exposure: { shownHashes: candidates.map(candidate => candidate.hash), aiVisible: !bulk,
        policy: 'seeded-random-simulation', probability: 1 / candidates.length },
      tie: false };
  });
}
function holdoutGroups(pool, style, dayOffset) {
  return pool.map((source, index) => ({ ...source, id: `${source.id}:${style}:${dayOffset}`, sourceGroup: source.id,
    time: new Date(Date.UTC(2026, 0, 1) +
    (dayOffset + index) * 86400000).toISOString(), winners: [winner(source.candidates, style)], signal: 'explicit' }));
}
export function runSimulation(pool, options = {}) {
  if (pool.length < 4) throw new Error('Insufficient independent cached groups');
  const boundary = Math.floor(pool.length * 0.7), trainPool = pool.slice(0, boundary), testPool = pool.slice(boundary);
  const events = simulateGroups(trainPool, options);
  const test = holdoutGroups(testPool, 'dark-tight', 500);
  const curve = [10, 25, 50, 100, 200].map(count => {
    const head = fitPreferenceHead(events.slice(0, count));
    return { groups: count, independentTrainingSources: new Set(events.slice(0, count).map(g => g.sourceGroup)).size,
      ...scorePreferenceHead(test, head, { repetitions: 1000 }) };
  });
  const switched = simulateGroups(trainPool, { ...options, seed: 99, style: 'bright-loose', count: 200, dayOffset: 200 });
  const oldHead = fitPreferenceHead(events);
  const driftBefore = holdoutGroups(testPool, 'dark-tight', 600);
  const driftAfter = holdoutGroups(testPool, 'bright-loose', 700);
  const drift = driftReport([...driftBefore, ...driftAfter], oldHead, { recentGroups: testPool.length });
  const switchedTest = holdoutGroups(testPool, 'bright-loose', 800);
  const all = [...events, ...switched];
  const noDecay = scorePreferenceHead(switchedTest, fitPreferenceHead(all, { halfLifeDays: Infinity }), { repetitions: 1000 });
  const decay = scorePreferenceHead(switchedTest, fitPreferenceHead(all, { halfLifeDays: 20 }), { repetitions: 1000 });
  const stableIndex = curve.findIndex((row, i) => i < curve.length - 1 && row.improvement.lower > 0 &&
    curve.slice(i).every(later => later.improvement.lower > 0 && Math.abs(later.after.estimate - row.after.estimate) <= 0.05));
  // This honest production gate will often refuse repeated cache observations after content purging.
  const productionEvaluation = evaluatePreferenceHead([...events, ...test]);
  return { actionCount: all.length, independentSources: pool.length, trainSources: trainPool.length,
    holdoutSources: testPool.length, curve, stableAtActions: stableIndex < 0 ? null : curve[stableIndex].groups,
    drift, preferenceSwitch: { noDecay, halfLife20Days: decay }, productionEvaluation,
    caveat: 'Repeated simulated actions share source bursts. Holdout source groups/content never train. '
      + 'Intervals resample independent held-out source groups; this does not establish a real-user sample threshold.' };
}
export function renderLearningCurve(results) {
  const width = 900, height = 520, left = 70, top = 65, plotWidth = 750, plotHeight = 365;
  const x = count => left + (Math.log(count / 10) / Math.log(20)) * plotWidth;
  const y = rate => top + (1 - rate) * plotHeight;
  const colors = ['#146ab8', '#b35113'];
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="white"/>',
    '<g font-family="sans-serif" font-size="13" fill="#222">',
    '<text x="70" y="28" font-size="19">L1 simulated users: source-disjoint future holdout</text>'];
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) lines.push(
    `<path d="M${left} ${y(tick)}H${left + plotWidth}" stroke="#ddd"/>`,
    `<text x="30" y="${y(tick) + 4}">${tick}</text>`);
  for (const count of [10, 25, 50, 100, 200]) lines.push(`<text x="${x(count) - 12}" y="455">${count}</text>`);
  results.forEach((entry, index) => {
    const color = colors[index % colors.length];
    lines.push(`<text x="${70 + index * 340}" y="52" fill="${color}">${entry.name}: L1 solid / L0 dashed; group bootstrap 95% CI</text>`);
    for (const key of ['before', 'after']) {
      const points = entry.result.curve.map(row => `${x(row.groups)},${y(row[key].estimate)}`).join(' ');
      const dash = key === 'before' ? 'stroke-dasharray="6 4"' : '';
      lines.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`);
    }
    for (const row of entry.result.curve) lines.push(
      `<path d="M${x(row.groups)} ${y(row.after.lower)}V${y(row.after.upper)}" stroke="${color}"/>`,
      `<circle cx="${x(row.groups)}" cy="${y(row.after.estimate)}" r="4" fill="${color}"/>`);
  });
  lines.push('<text x="230" y="488">Simulated actions (log scale); repeated cached bursts are not independent new groups</text>',
    '</g></svg>');
  return lines.join('\n');
}
async function loadPools() {
  const manifest = await readJSON('test/fixtures/bench-syn-manifest.json');
  const names = (await readdir('data/cache/bench/reports')).sort().reverse();
  let bench, cache;
  for (const name of names) {
    const report = await readJSON(`data/cache/bench/reports/${name}/report.json`);
    try {
      const entries = [];
      for (const image of manifest.images) entries.push([image.id, { ...await readJSON(
        `data/cache/bench/analysis/${digest(`${image.sha256}:${report.analysisSignature}`)}.json`),
        unitId: image.id, contentHash: image.sha256 }]);
      bench = report; cache = new Map(entries); break;
    } catch { /* Try an older complete cache; never infer missing features. */ }
  }
  if (!cache) throw new Error('No complete T-syn analysis cache; refusing cold model inference');
  function candidates(items) {
    const ranking = new Map(rankGroup(items).map(row => [row.unitId, row]));
    return items.map(feature => {
      const row = ranking.get(feature.unitId);
      return { hash: feature.contentHash || digest(feature.fingerprint || feature.unitId), feature,
        baselineScore: row.score, baselineRank: row.rank,
        tier: (row.reasons.includes('硬伤门槛：排在通过者之后') ? 2 : 0)
          + (row.reasons.includes('同组睁眼帧优先') ? -1 : 0) };
    });
  }
  const tsyn = manifest.sources.map(source => ({ id: `tsyn:${source.id}`, candidates: candidates([
    cache.get(source.id), ...manifest.pairs.filter(pair => pair.sourceId === source.id).map(pair => cache.get(pair.degradedId))]) }));
  const old = await readJSON(requireLocalSetting('ECP_EVAL_RUN')), byId = new Map(old.results.map(result => [result.unitId, result]));
  const shantou = old.groups.filter(group => group.unitIds.length > 1).map(group => ({
    id: group.id, candidates: candidates(group.unitIds.map(id => byId.get(id)).filter(Boolean)) }));
  return { tsyn, shantou, provenance: { tsynReport: bench.createdAt, cacheSignature: bench.analysisSignature,
    tsynImages: manifest.images.length, shantouRun: old.run?.id || 'run-1791589678002',
    shantouUnits: old.results.length, modelsInvoked: 0 } };
}
export async function main(argv = process.argv.slice(2)) {
  const outIndex = argv.indexOf('--out'), out = outIndex < 0 ? '/tmp/w7-personalization-qa' : argv[outIndex + 1];
  if (!out || argv.some((arg, index) => arg !== '--out' && index !== outIndex + 1)) throw new Error('Usage: --out <directory>');
  const pools = await loadPools();
  const results = [{ name: 'T-syn', result: runSimulation(pools.tsyn) },
    { name: 'Shantou', result: runSimulation(pools.shantou) }];
  const report = { version: 1, seed: 42, generatedAt: new Date().toISOString(), provenance: pools.provenance,
    hiddenPreferences: ['dark tone / tight crop / stronger closed-eye penalty', 'switch: bright tone / loose crop'],
    methodology: '200 initial + 200 switched actions per corpus; '
      + 'complete source-disjoint heldout groups; fixed local features only', results };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'learning-curve.svg'), renderLearningCurve(results));
  console.log(JSON.stringify({ out, provenance: report.provenance, results: results.map(({ name, result }) => ({
    name, stableAtActions: result.stableAtActions, curve: result.curve, drift: result.drift,
    switch: result.preferenceSwitch, productionGate: result.productionEvaluation.reason })) }, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
