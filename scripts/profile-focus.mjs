#!/usr/bin/env node
// Local-only experiment. Never imported by the production pipeline.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { EagleApi } from '../src/core/eagle-api.js';
import { readMakerFocus } from '../src/core/focus.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const runId = process.env.FOCUS_PROFILE_RUN || 'run-1791589678002';
const sampleCount = Number(process.env.FOCUS_PROFILE_COUNT || 20);
const candidateMode = process.env.FOCUS_PROFILE_VARIANT === 'default' ? 'D' :
  process.env.FOCUS_PROFILE_VARIANT === 'aligned' ? 'C' : 'B';
const prefix = `import { performance as profileClock } from 'node:perf_hooks';
export const profileTimes = {};
export const profileEvents = [];
async function profileStep(name, fn) {
  const start = profileClock.now();
  try { return await fn(); }
  finally {
    const durationMs = profileClock.now() - start;
    profileTimes[name] = (profileTimes[name] || 0) + durationMs;
    profileEvents.push({ name, durationMs });
  }
}
`;
function replaceExact(source, from, to) {
  assert.equal(source.split(from).length, 2, `Instrumentation anchor must occur once: ${from}`);
  return source.replace(from, to);
}
export async function instrument(mode, directory) {
  let focus = await readFile(path.join(ROOT, 'src/core/focus.js'), 'utf8');
  focus = replaceExact(focus, 'const { data, info } = await sharp(input).rotate().resize',
    "const { data, info } = await profileStep('roi.decode-resize-grey', () => " +
    "(input && typeof input.clone === 'function' ? input.clone() : sharp(input).rotate()).resize");
  focus = replaceExact(focus, 'fit: "inside", withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });',
    'fit: "inside", withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true }));');
  focus = replaceExact(focus, 'const w = info.width, h = info.height;',
    'const computeStart = profileClock.now();\n  const w = info.width, h = info.height;');
  focus = replaceExact(focus, 'const mean = sum / n;',
    "profileTimes['roi.clarity-compute'] = (profileTimes['roi.clarity-compute'] || 0) + profileClock.now() - computeStart;\n" +
    '  const mean = sum / n;');
  for (const crop of ['crop', 'faceCrop']) {
    const direct = `focusMetrics(await sharp(source).rotate().extract(${crop}).jpeg().toBuffer())`;
    const old = focus.includes(direct) ? direct : `focusMetrics(await cropJpeg(${crop}))`;
    const replacement = mode === 'D'
      ? `focusMetrics(await profileStep('roi.default-aligned-q96-q80', () => cropJpeg(${crop})))`
      : mode === 'C'
      ? `focusMetrics(await profileStep('roi.aligned-q96-crop-q80', () => alignedFocusJpegRoi(source, meta, ${crop})))`
      : mode === 'A'
      ? `focusMetrics(await profileStep('roi.source-decode-crop-encode', () => ` +
        `sharp(source).rotate().extract(${crop}).jpeg().toBuffer()))`
      : `focusMetrics(sharp(source.data, { raw: source.info }).extract(${crop}))`;
    focus = replaceExact(focus, old, replacement);
  }
  let native = await readFile(path.join(ROOT, 'src/core/native-image.js'), 'utf8');
  native = replaceExact(native,
    'const runCommand = (program, args, settings = {}) => command(program, args, { ...settings, signal: options.signal });',
    'const runCommand = (program, args, settings = {}) => profileStep(' +
    "program === 'exiftool' ? (settings.binary ? 'extract.embedded-jpeg' : 'extract.metadata') : 'extract.' + program, " +
    '() => command(program, args, { ...settings, signal: options.signal }));');
  native = replaceExact(native, 'return callback({ image, source });', 'return callback({ image, source, input });');
  // Temporary files are beside the originals solely to preserve relative imports and package resolution.
  const token = crypto.randomUUID();
  const focusFile = path.join(ROOT, 'src/core', `.focus-profile-${token}.mjs`);
  const nativeFile = path.join(ROOT, 'src/core', `.native-profile-${token}.mjs`);
  const extraImport = mode === 'C' && !focus.includes('import { alignedFocusJpegRoi,')
    ? "import { alignedFocusJpegRoi } from './focus-jpeg-roi.js';\n" : '';
  await writeFile(focusFile, extraImport + prefix + focus);
  await writeFile(nativeFile, prefix + native);
  await writeFile(path.join(directory, `instrumentation-${mode}.json`), JSON.stringify({
    focusSha256: crypto.createHash('sha256').update(focus).digest('hex'),
    nativeSha256: crypto.createHash('sha256').update(native).digest('hex'),
  }));
  return { focusFile, nativeFile };
}

async function worker(mode, directory) {
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 10 });
  const run = JSON.parse(await readFile(path.join(ROOT, 'data/runs', runId, 'results.json'), 'utf8'));
  const eagle = new EagleApi();
  await eagle.assertLibrary(run.run.libraryPath);
  const units = new Map(run.units.map(unit => [unit.id, unit]));
  const items = new Map(run.items.map(item => [item.id, item]));
  const eligible = run.results.filter(result => result.faces?.length).map(result => {
    const unit = units.get(result.unitId);
    const primary = items.get(unit.primaryItemId);
    return { result, record: { ...primary, unitId: unit.id,
      pairedItems: unit.itemIds.filter(id => id !== primary.id).map(id => items.get(id)).filter(Boolean) } };
  });
  const heic = eligible.filter(x => x.record.ext === 'heic').slice(0, 2);
  const small = eligible.filter(x => x.record.ext === 'jpg' && x.record.width * x.record.height < 10_000_000).slice(0, 6);
  const large = eligible.filter(x => x.record.ext === 'jpg' && x.record.width * x.record.height >= 10_000_000);
  const selected = [...heic, ...small, ...large].slice(0, sampleCount);
  assert.equal(selected.length, sampleCount);
  const files = await instrument(mode, directory);
  const focusModule = await import(files.focusFile);
  const nativeModule = await import(files.nativeFile);
  const rows = [];
  let peakSampledRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss); }, 20);
  try {
    for (const { record, result } of selected) {
      const times = {};
      const time = async (key, fn) => {
        const start = performance.now();
        try { return await fn(); } finally { times[key] = performance.now() - start; }
      };
      for (const key of Object.keys(focusModule.profileTimes)) delete focusModule.profileTimes[key];
      focusModule.profileEvents.length = 0;
      nativeModule.profileEvents.length = 0;
      for (const key of Object.keys(nativeModule.profileTimes)) delete nativeModule.profileTimes[key];
      const start = performance.now();
      const maker = await time('maker-note', () => readMakerFocus(record.filePath));
      let nativeSource;
      const output = await nativeModule.withNativeImage(record, {}, async ({ image, source }) => {
        nativeSource = source;
        const nativeSize = { width: source.width, height: source.height, orientation: source.orientation,
          rawWidth: source.rawWidth, rawHeight: source.rawHeight };
        if (mode === 'D') return time('native-and-roi.optimized-total', () => focusModule.analyzeFocusFromNativeImage({
          image, source, faces: result.faces, makerFocus: maker }));
        const nativeBuffer = mode === 'A'
          ? await time('native.decode-orient-full-jpeg', () => image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer())
          : await time('native.decode-orient-raw', () => image().removeAlpha().toColourspace('srgb')
            .raw().toBuffer({ resolveWithObject: true }));
        if (mode !== 'A') nativeBuffer.info = {
          width: nativeBuffer.info.width, height: nativeBuffer.info.height, channels: nativeBuffer.info.channels };
        return time('roi.total', () => focusModule.analyzeFocus({ nativeBuffer, nativeSize, faces: result.faces, makerFocus: maker }));
      });
      times.total = performance.now() - start;
      Object.assign(times, nativeModule.profileTimes, focusModule.profileTimes);
      rows.push({ unitId: result.unitId, name: record.name, ext: record.ext, source: nativeSource || null,
        events: { native: [...nativeModule.profileEvents], roi: [...focusModule.profileEvents] },
        inputVersion: await Promise.all([record, ...record.pairedItems].map(async item => {
          const info = await stat(item.filePath);
          return [item.filePath, info.size, info.mtimeMs];
        })), times, output });
      console.error(`${mode}: ${rows.length}/${selected.length} ${record.name} ${output.status || output.naReason}`);
      // No buffers are retained between units. Encourage reclamation before the next full decode.
      global.gc?.();
    }
    await eagle.assertLibrary(run.run.libraryPath);
    const report = { mode, runId, rows, nodeMaxRssKiB: process.resourceUsage().maxRSS, peakSampledRss,
      sharp: sharp.versions, sharpConcurrency: sharp.concurrency() };
    await writeFile(path.join(directory, `report-${mode}.json`), JSON.stringify(report, null, 2));
  } finally {
    clearInterval(sample);
    await rm(files.focusFile, { force: true });
    await rm(files.nativeFile, { force: true });
  }
}

export function differences(a, b, field = '') {
  if (isDeepStrictEqual(a, b)) return [];
  if (typeof a === 'number' && typeof b === 'number') return [{ field, a, b, delta: b - a,
    relative: a === 0 ? null : (b - a) / Math.abs(a) }];
  if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .flatMap(key => differences(a[key], b[key], field ? `${field}.${key}` : key));
  return [{ field, a, b }];
}

async function summarizeReports(directory) {
  const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'));
  const run = JSON.parse(await readFile(path.join(ROOT, 'data/runs', summary.runId, 'results.json'), 'utf8'));
  const comparisonMode = summary.rounds[1].mode;
  const reports = await Promise.all(['1/report-A.json', `2/report-${comparisonMode}.json`,
    '3/report-A.json', `4/report-${comparisonMode}.json`]
    .map(name => readFile(path.join(directory, name), 'utf8').then(JSON.parse)));
  const stats = {};
  for (const field of ['eyeSharpnessNative', 'faceSharpnessNative', 'laplacianVariance', 'highFrequency']) {
    const values = summary.comparisons[0].flatMap(row => row.differences)
      .filter(row => row.field === field || row.field.endsWith('.' + field));
    const relative = values.filter(row => row.relative != null);
    stats[field] = { count: values.length,
      meanAbsDelta: values.reduce((sum, row) => sum + Math.abs(row.delta), 0) / values.length,
      maxAbsDelta: Math.max(...values.map(row => Math.abs(row.delta))),
      meanAbsRelative: relative.reduce((sum, row) => sum + Math.abs(row.relative), 0) / relative.length,
      maxAbsRelative: Math.max(...relative.map(row => Math.abs(row.relative))) };
  }
  const { groupResultsAsync } = await import('../src/core/grouping.js');
  const { rankGroup, suggestDecision, groupConfidence } = await import('../src/core/ranking.js');
  const { buildCandidateSet } = await import('../src/core/candidates.js');
  async function replay(report) {
    const focus = new Map(report.rows.map(row => [row.unitId, row.output]));
    const results = structuredClone(run.results).map(result => {
      if (focus.has(result.unitId)) {
        result.focus = focus.get(result.unitId);
        if (result.focus.afPointOnSubject === false || result.focus.afPointOnEye === false)
          result.flags = [...new Set([...(result.flags || []), 'focus-miss'])];
      }
      return result;
    });
    const groups = await groupResultsAsync(results);
    return groups.map(group => {
      const ranking = rankGroup(group.items, undefined, { averageSimilarity: group.averageSimilarity });
      const suggested = ranking.map(entry => [entry.unitId,
        suggestDecision(entry, group.items.find(row => row.unitId === entry.unitId), ranking.length)]);
      if (ranking.length > 1 && !suggested.some(([, value]) => value === 'selected')) {
        const fallback = suggested.findIndex(([, value]) => value !== 'rejected');
        if (fallback >= 0) suggested[fallback][1] = 'selected';
      }
      return { id: group.id, unitIds: group.unitIds, ranking,
        confidence: groupConfidence({ unitIds: group.unitIds, ranking }, group.items),
        suggested: Object.fromEntries(suggested), candidateSet: buildCandidateSet(group.items) };
    });
  }
  const a = await replay(reports[0]), b = await replay(reports[1]);
  const controlEqual = summary.comparisons.every(rows => rows.every(row => row.differences.every(diff =>
    !['status', 'naReason', 'afPointOnEye', 'afPointOnSubject', 'relativeRank', 'confidence'].includes(diff.field))));
  const output = { stats, controlEqual, groupsAndRankingDeepEqual: isDeepStrictEqual(a, b), groupCount: a.length,
    aRepeatDeepEqual: reports[0].rows.every((row, i) => isDeepStrictEqual(row.output, reports[2].rows[i].output)),
    bRepeatDeepEqual: reports[1].rows.every((row, i) => isDeepStrictEqual(row.output, reports[3].rows[i].output)),
    successfulTotals: reports.map(report => ({ mode: report.mode,
      totalMs: report.rows.filter(row => row.output.status === 'ok').reduce((sum, row) => sum + row.times.total, 0) })) };
  await writeFile(path.join(directory, 'difference-summary.json'), JSON.stringify(output, null, 2));
  return output;
}

async function probe() {
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 10 });
  const root = path.join(ROOT, 'data/cache/w23-decode');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'focus-probe-'));
  const run = JSON.parse(await readFile(path.join(ROOT, 'data/runs', runId, 'results.json'), 'utf8'));
  const eagle = new EagleApi();
  await eagle.assertLibrary(run.run.libraryPath);
  const items = new Map(run.items.map(item => [item.id, item]));
  const units = new Map(run.units.map(unit => [unit.id, unit]));
  const records = run.results.filter(result => result.faces?.length).map(result => {
    const unit = units.get(result.unitId), primary = items.get(unit.primaryItemId);
    return { ...primary, pairedItems: unit.itemIds.filter(id => id !== primary.id).map(id => items.get(id)) };
  });
  const selected = [records.find(r => r.ext === 'jpg' && r.width * r.height < 10_000_000),
    records.find(r => r.ext === 'jpg' && r.width * r.height >= 10_000_000), records.find(r => r.ext === 'heic')].filter(Boolean);
  const files = await instrument('A', directory);
  const { withNativeImage } = await import(files.nativeFile);
  const rows = [];
  try {
    for (const record of selected) {
      const times = {};
      const time = async (key, fn) => {
        const start = performance.now();
        try { return await fn(); } finally { times[key] = performance.now() - start; }
      };
      const output = await withNativeImage(record, {}, async ({ image, source, input }) => {
        const decoded = await time('decodeOnlyMs', () => sharp(input, { limitInputPixels: 160_000_000 })
          .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }));
        const raw = { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels };
        let upright = sharp(decoded.data, { raw });
        if ([2, 4, 5, 7].includes(source.orientation)) upright = upright.flop();
        const angle = ({ 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 })[source.orientation] || 0;
        const oriented = await time('orientationOnlyMs', () => upright.rotate(angle).raw().toBuffer({ resolveWithObject: true }));
        const orientedRaw = { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels };
        const encoded = await time('fullJpegEncodeOnlyMs', () => sharp(oriented.data, { raw: orientedRaw })
          .jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer());
        const expected = await image().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        const baselineJpeg = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
        return { source, pixelsEqual: decoded.info.channels === expected.info.channels && oriented.data.equals(expected.data),
          fullJpegBytesEqual: encoded.equals(baselineJpeg), rawBytes: oriented.data.length };
      });
      rows.push({ name: record.name, ext: record.ext, times, output });
      global.gc?.();
    }
    await eagle.assertLibrary(run.run.libraryPath);
    await writeFile(path.join(directory, 'probe.json'), JSON.stringify({ rows, nodeMaxRssKiB: process.resourceUsage().maxRSS }, null, 2));
    console.log(JSON.stringify({ directory, rows }, null, 2));
  } finally {
    await rm(files.focusFile, { force: true });
    await rm(files.nativeFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
if (process.argv[2] === '--summarize') {
  console.log(JSON.stringify(await summarizeReports(process.argv[3]), null, 2));
} else if (process.argv[2] === '--probe') {
  await probe();
} else if (process.argv[2] === '--worker') {
  await worker(process.argv[3], process.argv[4]);
} else {
  const root = path.join(ROOT, 'data/cache/w23-decode');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'focus-abab-'));
  console.error(`Reports: ${directory}`);
  for (const [index, mode] of ['A', candidateMode, 'A', candidateMode].entries()) {
    const round = path.join(directory, String(index + 1));
    await mkdir(round);
    await new Promise((resolve, reject) => {
      const child = fork(SELF, ['--worker', mode, round], { cwd: ROOT,
        execArgv: ['--expose-gc', '--max-old-space-size=2048'], stdio: 'inherit' });
      const timeout = setTimeout(() => child.kill('SIGTERM'), 125_000);
      child.once('error', reject);
      child.once('exit', code => {
        clearTimeout(timeout);
        if (code === 0) resolve(); else reject(new Error(`Round ${index + 1} failed: ${code}`));
      });
    });
  }
  const reports = await Promise.all(['1/report-A.json', `2/report-${candidateMode}.json`,
    '3/report-A.json', `4/report-${candidateMode}.json`]
    .map(name => readFile(path.join(directory, name), 'utf8').then(JSON.parse)));
  const comparisons = [0, 2].map(index => {
    const a = reports[index], b = reports[index + 1];
    return a.rows.map((row, i) => {
      assert.equal(row.unitId, b.rows[i].unitId);
      assert.deepEqual(row.inputVersion, b.rows[i].inputVersion);
      return { unitId: row.unitId, deepEqual: isDeepStrictEqual(row.output, b.rows[i].output),
        differences: differences(row.output, b.rows[i].output) };
    });
  });
  const summary = { runId, directory, sampleCount, comparisons,
    rounds: reports.map(r => ({ mode: r.mode, nodeMaxRssKiB: r.nodeMaxRssKiB,
      successful: r.rows.filter(x => x.output.status === 'ok').length,
      totalMs: r.rows.reduce((sum, row) => sum + row.times.total, 0),
      substepsMs: Object.fromEntries([...new Set(r.rows.flatMap(row => Object.keys(row.times)))].map(key =>
        [key, r.rows.reduce((sum, row) => sum + (row.times[key] || 0), 0)])) })) };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  await summarizeReports(directory);
  console.log(JSON.stringify({ directory, rounds: summary.rounds,
    mismatchCounts: comparisons.map(rows => rows.filter(row => !row.deepEqual).length) }, null, 2));
}

}
