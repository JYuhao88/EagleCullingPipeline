import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { inventory } from './windows-library.mjs';
import { hashFile } from '../src/core/metrics.js';
import { createReadOnlyEagleProxy } from './eagle-readonly-proxy.mjs';
import { EagleApi, normalizeLibraryPath } from '../src/core/eagle-api.js';
import { ResultsStore } from '../src/core/results-store.js';
import { RunStore } from '../src/server/run-store.js';
import { detectFaces } from '../src/core/faces.js';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
if (process.platform !== 'win32') throw new Error('Real pixels must stay on Windows');
const config = await read(process.argv[2]);
const target = Number(process.argv[3] || 1500);
const preferenceCohort = process.env.EAGLE_VALIDATION_COHORT === 'ratings';
if (!Number.isInteger(target) || target < 1 || target > 4000) throw new Error('Invalid bounded item limit');
process.env.EAGLE_SCORER_PROVIDER = 'dml';
process.env.EAGLE_DINO_PROVIDER = 'dml';
process.env.EAGLE_POSE_PROVIDER = 'DmlExecutionProvider';
const { createAnalysisServer } = await import('../src/server.js');
const { AnalysisPipeline } = await import('../src/core/pipeline.js');
const { detectPose } = await import('../src/core/pose.js');
const root = path.resolve('data/windows-test');
await mkdir(root, { recursive: true });
const shared = process.env.EAGLE_VALIDATION_SERVICE;
const proxy = shared ? null : createReadOnlyEagleProxy();
if (proxy) await new Promise(resolve => proxy.server.listen(0, '127.0.0.1', resolve));
const api = new EagleApi({ baseUrl: shared ? 'http://127.0.0.1:43136/api/v2'
  : `http://127.0.0.1:${proxy.server.address().port}/api/v2` });
const pipeline = new AnalysisPipeline({ concurrency: 1, cacheRoot: path.join(root, 'cache'),
  store: new ResultsStore(path.join(root, 'cache')),
  faceDetector: (files, options) => detectFaces(files, { ...options, size: 1 }),
  poseDetector: (items, options) => detectPose(items, { ...options, size: 1 }) });
const runStore = new RunStore(path.join(root, 'runs'));
const service = shared ? null : createAnalysisServer({ port: 0, pipeline, runStore, api });
if (service) await service.listen();
const base = shared || `http://127.0.0.1:${service.server.address().port}`;
async function request(url, body) {
  const response = await fetch(base + url, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local service HTTP ${response.status}`);
  return response.json();
}
const summaries = [];
try {
  const live = await api.libraryInfo();
  const activeIndex = config.libraries.findIndex(library => normalizeLibraryPath(library) === normalizeLibraryPath(live.path));
  // An unknown or protected active library never receives item requests.
  if (activeIndex < 0 || String(live.path).includes('未删减')) throw new Error('Open one of the configured safe libraries in Eagle');
  for (const [index, library] of config.libraries.entries()) {
    const { items, folders, summary } = await inventory(library);
    const allowed = folders.filter(folder => !folder.protected && folder.count >= 100)
      .sort((a, b) => target <= 500 ? Math.abs(a.count - target) - Math.abs(b.count - target) : a.count - b.count);
    const selected = [], seen = new Set(), folderHashes = [];
    const ratedItems = items.filter(item => Number(item.star) > 0);
    if (preferenceCohort && !ratedItems.length) continue;
    const add = item => { if (!seen.has(item.id)) { selected.push(item); seen.add(item.id); } };
    if (preferenceCohort) {
      // Preserve all explicit evidence, then paired formats and safe folder neighbours.
      for (const item of ratedItems) add(item);
      const stems = new Set(ratedItems.map(item => item.name));
      for (const item of items) if (stems.has(item.name)) add(item);
      const related = new Set(ratedItems.flatMap(item => item.folders || []));
      for (const item of items) {
        if (selected.length >= target) break;
        if ((item.folders || []).some(id => related.has(id))) add(item);
      }
    }
    for (const folder of preferenceCohort ? [] : allowed) {
      folderHashes.push(folder.hash);
      for (const item of items) if (item.folders?.includes(folder.id) && !seen.has(item.id)) {
        selected.push(item); seen.add(item.id);
        if (selected.length >= target) break;
      }
      if (selected.length >= target || target <= 500 && selected.length) break;
    }
    if (!selected.length) throw new Error('No safe folder subset');
    const label = `library-${index + 1}-${preferenceCohort ? 'ratings-' : ''}${target}`;
    const directory = path.join(root, label);
    await mkdir(directory, { recursive: true });
    let originalEntries;
    try { originalEntries = await read(path.join(directory, 'integrity-before.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      originalEntries = [];
      for (const item of selected) originalEntries.push([item.id, (await hashFile(item.filePath)).sha256]);
      await writeFile(path.join(directory, 'integrity-before.json'), JSON.stringify(originalEntries));
    }
    if (JSON.stringify(originalEntries.map(row => row[0])) !== JSON.stringify(selected.map(item => item.id))) {
      throw new Error('Selection changed since integrity checkpoint');
    }
    const originalHashes = new Map(originalEntries);
    let run;
    let checkpoint;
    try { checkpoint = await read(path.join(directory, 'run-id.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (checkpoint) {
      const saved = checkpoint;
      run = await request(`/runs/${saved.id}`);
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) run = await request('/runs', { resumeRunId: saved.id });
    } else {
      run = await request('/runs', { libraryPath: library, items: selected });
      await writeFile(path.join(directory, 'run-id.json'), JSON.stringify({ id: run.id }));
    }
    const started = Date.now(), stages = {};
    let previousStage = null, previousTime = started;
    while (run.status === 'running') {
      const now = Date.now(), stage = run.progress.stage;
      if (stage !== previousStage) {
        if (previousStage) stages[previousStage] = (stages[previousStage] || 0) + now - previousTime;
        previousStage = stage; previousTime = now;
        console.log(JSON.stringify({ label, stage, completed: run.progress.completed, total: run.progress.total }));
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      run = await request(`/runs/${run.id}`);
    }
    if (previousStage) stages[previousStage] = (stages[previousStage] || 0) + Date.now() - previousTime;
    if (run.status !== 'completed') throw new Error('Real analysis did not complete');
    const analysisSeconds = (Date.now() - started) / 1000;
    const state = await runStore.get(run.id);
    // Exercise review persistence and report export; these are harness decisions, not human labels.
    const unitId = state.units[0].id;
    const decisions = await request(`/runs/${run.id}/decisions`);
    if (!Object.keys(decisions.decisions || decisions).length) await request(`/runs/${run.id}/decisions`,
      { decisions: [{ unitId, action: 'candidate', source: 'human',
      updatedAt: new Date().toISOString(), reason: 'Windows 自动化审阅链路核对（非真实偏好标签）' }] });
    const report = await fetch(`${base}/runs/${run.id}/report?format=json`);
    if (!report.ok) throw new Error('Report export failed');
    const reportText = await report.text();
    await writeFile(path.join(directory, 'report.json'), reportText);
    let mismatches = 0;
    for (const item of selected) mismatches += Number(originalHashes.get(item.id) !== (await hashFile(item.filePath)).sha256);
    const byId = new Map(selected.map(item => [item.id, item]));
    const units = new Map(state.units.map(unit => [unit.id, unit]));
    const labels = [], rows = [];
    let orderedPairs = 0, agreeingPairs = 0;
    let conflictingRatedUnits = 0;
    for (const group of state.groups) {
      const rated = group.ranking.flatMap(rank => {
        const unit = units.get(rank.unitId);
        const evidence = (unit?.itemIds || []).map(id => byId.get(id)).filter(item => Number(item?.star) > 0);
        if (!evidence.length) return [];
        if (new Set(evidence.map(item => Number(item.star))).size !== 1) { conflictingRatedUnits++; return []; }
        const item = evidence[0];
        const entry = { idHash: digest(unit.id), sha256: originalHashes.get(item.id), star: Number(item.star),
          score: rank.score, rank: rank.rank, groupHash: digest(group.id) };
        labels.push(entry); return [entry];
      });
      for (const a of rated) for (const b of rated) if (a.star === 5 && b.star === 3) {
        orderedPairs++; agreeingPairs += a.rank < b.rank ? 1 : a.rank === b.rank ? 0.5 : 0;
      }
      if (new Set(rated.map(item => item.star)).size >= 2) {
        const maximum = Math.max(...rated.map(item => item.star));
        rows.push({ groupHash: digest(group.id), agrees: rated.find(item => item.rank === Math.min(...rated.map(x => x.rank)))
          .star === maximum, rated: rated.length });
      }
    }
    await writeFile(path.join(directory, 'rating-labels.json'), JSON.stringify(labels.map(({ idHash, sha256, star, groupHash }) =>
      ({ idHash, sha256, star, groupHash }))));
    const low = labels.filter(item => item.star <= 2), high = labels.filter(item => item.star >= 4);
    let concordant = 0;
    for (const a of high) for (const b of low) concordant += a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0;
    const five = labels.filter(item => item.star === 5), three = labels.filter(item => item.star === 3);
    let ordinal = 0;
    for (const a of five) for (const b of three) ordinal += a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0;
    const qa = path.resolve('..', 'qa', label);
    await mkdir(qa, { recursive: true });
    const samples = state.results.filter(row => row.previewPath).slice(0, 25);
    const tiles = [];
    for (const [i, row] of samples.entries()) {
      const tile = await sharp(row.previewPath).resize(160, 160, { fit: 'contain', background: 'white' }).jpeg().toBuffer();
      tiles.push({ input: tile, left: i % 5 * 160, top: Math.floor(i / 5) * 180 });
      const text = Buffer.from(`<svg width="160" height="20"><text x="4" y="15">${digest(row.unitId).slice(0, 10)}</text></svg>`);
      tiles.push({ input: text, left: i % 5 * 160, top: Math.floor(i / 5) * 180 + 160 });
    }
    if (tiles.length) await sharp({ create: { width: 800, height: Math.ceil(samples.length / 5) * 180,
      channels: 3, background: 'white' } }).composite(tiles).jpeg().toFile(path.join(qa, 'contact.jpg'));
    await writeFile(path.join(qa, 'index.html'), '<meta charset="utf-8"><title>Windows QA</title><img src="contact.jpg">');
    const proxyStatus = shared ? await request('/validation/status') : { requests: proxy.summary(),
      denied: proxy.requests.filter(row => !row.allowed).length,
      otherWriteRequests: proxy.requests.filter(row => row.method !== 'GET').length };
    const aggregate = { library: `library-${index + 1}`, requestedLimit: target, items: selected.length,
      units: run.unitCount, groups: run.groupCount, folderHashes, inventory: summary,
      analysisSeconds, cachedUnits: run.progress.cached, stagesMilliseconds: stages,
      integrity: { originalsChecked: originalHashes.size, mismatches }, reportRows: JSON.parse(reportText).length,
      proxyRequests: proxyStatus.requests, deniedRequests: proxyStatus.denied,
      writeRequests: proxyStatus.otherWriteRequests,
      ratings: { labels: labels.length, informativeGroups: rows.length, conflictingRatedUnits,
        cohort: preferenceCohort ? 'all explicit rated items plus paired formats and folder neighbours' : 'scale subset',
        withinGroupFiveVsThreePairs: orderedPairs,
        withinGroupFiveVsThreeAgreement: orderedPairs ? agreeingPairs / orderedPairs : null,
        ratingProvenanceConfirmed: false,
        fiveVsThreeOrdinalAuc: five.length && three.length ? ordinal / (five.length * three.length) : null,
        keepVsDropAuc: null,
        top1WithinRatedAgreement: rows.length ? rows.filter(row => row.agrees).length / rows.length : null,
        highStarVsLowStarAuc: high.length && low.length ? concordant / (high.length * low.length) : null,
        high: high.length, low: low.length, unlabeledZeroStar: selected.filter(item => !Number(item.star)).length,
        limitation: 'Ratings provenance unconfirmed; score AUC ignores safety strata; zero stars unlabeled; no keep/drop truth.' },
      missing: { quality: state.results.filter(row => row.metrics.quality === null).length,
        faces: state.results.filter(row => row.metrics.faces === null).length,
        pose: state.results.filter(row => !row.signals).length },
      focusAvailability: { ok: state.results.filter(row => row.focus?.status === 'ok').length,
        unavailable: state.results.filter(row => row.focus?.status !== 'ok').length },
      sourceKinds: state.results.reduce((counts, row) => {
        const kind = row.source?.kind || 'unavailable'; counts[kind] = (counts[kind] || 0) + 1; return counts;
      }, {}),
      poseProviders: [...new Set(state.results.map(row => row.pose?.provider).filter(Boolean))] };
    summaries.push(aggregate);
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(aggregate, null, 2));
    await writeFile(path.join(root, `summary-${preferenceCohort ? 'ratings-' : ''}${target}.json`), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify({ label, items: selected.length, groups: run.groupCount, mismatches }));
  }
  await api.assertLibrary(config.libraries[activeIndex]);
} finally {
  if (proxy) await writeFile(path.join(root, 'proxy-requests.json'), JSON.stringify(proxy.requests));
  if (service) await service.close();
  if (proxy) await new Promise(resolve => proxy.server.close(resolve));
}
process.exit(0);
