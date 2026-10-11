#!/usr/bin/env node
// Offline experiment only. Public reports contain aggregates; source identities stay in ignored cache.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { RunStore } from '../src/server/run-store.js';
import { CACHE, atomicJSON, thumbnail, withTeacher, budgetState } from './teacher-label.mjs';
import { samplePairs, kendall } from './teacher-pilot.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const ordered = entries => [...entries].sort((a, b) => hash(`teacher-v1:${a.id}`).localeCompare(hash(`teacher-v1:${b.id}`)));
const file = name => path.join(CACHE, `expansion-${name}.json`);

export function expandedPairs(manifest, count = 200) {
  const result = samplePairs(manifest), used = new Set(result.map(pair => pair.id));
  const add = pair => { if (!used.has(pair.id) && result.length < count) { result.push(pair); used.add(pair.id); } };
  // Exhaust the scarce joint-crop strata before allocating the remaining slots round-robin.
  for (const pair of ordered(manifest.pairs.filter(pair => pair.degradation.startsWith('joint-crop-')))) add(pair);
  const types = [...new Set(manifest.pairs.map(pair => pair.degradation))].sort();
  const strata = types.map(type => ordered(manifest.pairs.filter(pair => pair.degradation === type && !used.has(pair.id))));
  for (let round = 0; result.length < count; round++) {
    let available = false;
    for (const stratum of strata) if (stratum[round]) { available = true; add(stratum[round]); }
    if (!available) throw new Error('Insufficient distinct synthetic pairs');
  }
  return result;
}

export function wilson(hits, n) {
  if (!n) return null;
  const z = 1.959963984540054, p = hits / n, denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}

function rng(seed = 42) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrap(clusters, statistic, repetitions = 2000) {
  if (!clusters.length) return null;
  const random = rng(), values = [];
  for (let iteration = 0; iteration < repetitions; iteration++) {
    const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]);
    values.push(statistic(sample.flat()));
  }
  values.sort((a, b) => a - b);
  return { low: values[Math.floor((values.length - 1) * 0.025)], high: values[Math.floor((values.length - 1) * 0.975)] };
}

export function categories(text) {
  const labels = [];
  if (/模糊|失焦|清晰|锐|噪|曝光|过曝|欠曝|高光|暗部|眩光|技术/.test(text)) labels.push('技术问题');
  if (/表情|笑|眨|闭眼|睁眼|眼神|目光|神态|脸部状态/.test(text)) labels.push('表情');
  if (/构图|裁切|截断|关节|膝|踝|腕|脖|头顶|留白|地平|倾斜|背景|主体位置|空间/.test(text)) labels.push('构图');
  if (/审美|氛围|自然|色彩|色调|风格|美感|生动|感染|姿态|姿势|肢体/.test(text)) labels.push('审美');
  return labels.length ? labels : ['未归类'];
}

export function semanticRanking(row) {
  return row.response.result.ranking.map(id => row.unitIds[Number(id.slice(1)) - 1]);
}

async function inventory() {
  const store = new RunStore(), runs = [], candidates = [], imageInfo = new Map();
  let excluded = 0;
  for (const id of await readdir('data/runs')) {
    const metadata = await store.getRun(id);
    if (!metadata || metadata.status !== 'completed') continue;
    const data = await store.get(id, { readOnly: true });
    if (!data || JSON.stringify([metadata, data.items]).includes('未删减')) { excluded++; continue; }
    const sources = new Map(data.results.map(result => [result.unitId, result]));
    const directory = path.join('data/runs', id);
    let modified;
    try { modified = (await stat(path.join(directory, 'results-index.json'))).mtimeMs; }
    catch (error) { if (error.code !== 'ENOENT') throw error; modified = (await stat(path.join(directory, 'results.json'))).mtimeMs; }
    const groups = data.groups.filter(group => group.unitIds.length > 1);
    runs.push({ id, units: data.units.length, multi: groups.length, modified });
    for (const group of groups) {
      const images = [];
      let valid = true;
      for (const unitId of group.unitIds) {
        const preview = sources.get(unitId)?.previewPath;
        if (!preview || preview.includes('未删减')) { valid = false; break; }
        if (!imageInfo.has(preview)) {
          try { imageInfo.set(preview, { digest: hash(await thumbnail(preview)), sha256: hash(await readFile(preview)) }); }
          catch { valid = false; break; }
        }
        images.push({ unitId, path: preview, ...imageInfo.get(preview) });
      }
      if (!valid || group.unitIds.length > 100) { excluded++; continue; }
      const uniquePixels = [...new Set(images.map(image => image.digest))].sort();
      candidates.push({ runId: id, modified, groupId: group.id, unitIds: group.unitIds, images,
        key: hash(uniquePixels.join('|')), uniquePixels: uniquePixels.length,
        system: [...group.ranking].sort((a, b) => a.rank - b.rank).map(entry => entry.unitId) });
    }
  }
  const unique = new Map();
  for (const group of candidates.sort((a, b) => a.modified - b.modified || a.runId.localeCompare(b.runId))) {
    unique.set(group.key, group);
  }
  return { runs, candidates: candidates.length, groups: [...unique.values()], excluded };
}

async function prepare() {
  const manifest = await json('test/fixtures/bench-syn-manifest.json');
  const imageById = new Map(manifest.images.map(image => [image.id, image]));
  const trialA = await json(path.join(CACHE, 'pilot-a-input.json'));
  const trialByPair = new Map(trialA.map(group => [group.pairId, group]));
  const a = expandedPairs(manifest).map((pair, i) => {
    const ids = i % 2 ? [pair.degradedId, pair.sourceId] : [pair.sourceId, pair.degradedId];
    const group = trialByPair.get(pair.id) || { id: `A${i + 1}`, task: trialA[0].task, type: pair.degradation,
      expected: `I${ids.indexOf(pair.sourceId) + 1}`, pairId: pair.id,
      images: ids.map(id => ({ path: path.join('data/cache/bench/syn', imageById.get(id).path),
        sha256: imageById.get(id).sha256 })) };
    return { ...group, sourceId: pair.sourceId, strength: pair.strength, expectedGate: !!pair.expectedGate };
  });
  const scan = await inventory(), trialB = await json(path.join(CACHE, 'pilot-b-input.json'));
  const byUnits = new Map(scan.groups.map(group => [[...group.unitIds].sort().join('|'), group]));
  const used = new Set(), b = [];
  for (const old of trialB) {
    const current = byUnits.get([...old.unitIds].sort().join('|'));
    if (!current || used.has(current.key)) continue;
    b.push({ ...old, system: current.system, sourceRun: current.runId, key: current.key, uniquePixels: current.uniquePixels,
      images: old.images.map(image => ({ ...image })) });
    // Fill source checksums below without changing the previously sent image sequence.
    used.add(current.key);
  }
  for (const group of ordered(scan.groups.map(group => ({ ...group, id: group.key })))) {
    if (used.has(group.key) || b.length >= 150) continue;
    const unitIds = ordered(group.unitIds.map(id => ({ id }))).map(entry => entry.id);
    b.push({ id: `B${String(b.length + 1).padStart(2, '0')}`, task: trialB[0].task, groupId: group.groupId,
      unitIds, system: group.system, sourceRun: group.runId, key: group.key, uniquePixels: group.uniquePixels,
      images: unitIds.map(id => { const image = group.images.find(image => image.unitId === id);
        return { path: image.path, sha256: image.sha256 }; }) });
    used.add(group.key);
  }
  for (const group of b) for (const image of group.images) image.sha256 = hash(await readFile(image.path));
  const eligible = b.filter(group => group.uniquePixels > 1);
  const c = ordered(eligible).slice(0, 30).map(group => ({ ...group, id: `P-${group.id}`, baseId: group.id,
    images: [...group.images].reverse(), unitIds: [...group.unitIds].reverse() }));
  const selection = await json(path.join(CACHE, 'pilot-selection.json'));
  const plan = { models: selection.selected, syntheticPairs: a.length, realGroups: b.length, repeatedGroups: c.length,
    inventory: { runs: scan.runs, rawMultiGroups: scan.candidates, uniqueGroups: scan.groups.length, excluded: scan.excluded,
      gapTo100: Math.max(0, 100 - b.length), gapTo150: Math.max(0, 150 - b.length) },
    stabilityCriterion: { perGroupUnreliable: 'top1 changes or Kendall tau < 0.8',
      aggregateRequired: 'top1 >= 0.9 and Wilson lower bound >= 0.8; mean tau >= 0.8' } };
  await atomicJSON(file('a-input'), a); await atomicJSON(file('b-input'), b); await atomicJSON(file('c-input'), c);
  await atomicJSON(file('plan'), plan);
  console.log(JSON.stringify({ models: plan.models, a: a.length, b: b.length, c: c.length,
    unique: scan.groups.length, raw: scan.candidates, gapTo100: plan.inventory.gapTo100 }));
}

async function run(phase, model, budget, enabled) {
  const plan = await json(file('plan'));
  if (!plan.models.includes(model)) throw new Error('Model not selected by pilot cost/accuracy policy');
  const input = await json(file(`${phase}-input`)), rows = [];
  await withTeacher({ model, budget, enabled }, async (label, state) => {
    for (const group of input) {
      let response;
      try { response = await label(group); }
      catch (error) {
        if (!error.requestId) throw error;
        response = { requestId: error.requestId, model, valid: false, result: null,
          error: error.failureKind || 'json-retries-exhausted' };
      }
      rows.push({ ...group, response }); await atomicJSON(file(`${phase}-${model}`), rows);
      const balance = state();
      console.log(JSON.stringify({ phase, model, processed: rows.length, total: input.length, valid: response.valid,
        cached: !!response.cached, spent: balance.spent, reserved: balance.reserved }));
    }
  });
}

function summarizeA(rows) {
  const values = rows.map(row => ({ ...row, correct: row.response.result?.ranking[0] === row.expected }));
  const sources = [...new Set(values.map(row => row.sourceId))].sort();
  const correct = values.filter(row => row.correct).length;
  const ratio = list => list.filter(row => row.correct).length / list.length;
  const byType = {};
  for (const type of [...new Set(values.map(row => row.type))].sort()) {
    const stratum = values.filter(row => row.type === type);
    const hits = stratum.filter(row => row.correct).length;
    byType[type] = { n: stratum.length, correct: hits, accuracy: hits / stratum.length, wilson95: wilson(hits, stratum.length) };
  }
  const joints = values.filter(row => row.type.startsWith('joint-crop-'));
  return { n: rows.length, correct, accuracy: correct / rows.length, sourceCount: sources.length,
    sourceBootstrap95: bootstrap(sources.map(source => values.filter(row => row.sourceId === source)), ratio),
    wilson95: wilson(correct, rows.length), byType, joint: { n: joints.length, correct: joints.filter(row => row.correct).length,
      errors: joints.filter(row => !row.correct).map(row => ({ id: row.id, pairId: row.pairId, type: row.type,
        strength: row.strength, sourceId: row.sourceId, expected: row.expected,
        teacher: row.response.result?.ranking[0] || null, labels: row.response.result?.images || [],
        error: row.response.error || null })) } };
}

function summarizeB(rows) {
  const comparisons = [], disagreements = [], typeCounts = {};
  for (const row of rows) {
    if (!row.response.valid) continue;
    const teacher = semanticRanking(row), top1 = Number(teacher[0] === row.system[0]);
    const tau = kendall(row.system, teacher);
    comparisons.push({ id: row.id, top1, tau });
    if (top1) continue;
    const important = row.response.result.images.filter(image => [teacher[0], row.system[0]]
      .includes(row.unitIds[Number(image.id.slice(1)) - 1]));
    const labels = categories(important.map(image => [image.reason, ...image.issues].join(' ')).join(' '));
    for (const label of labels) typeCounts[label] = (typeCounts[label] || 0) + 1;
    disagreements.push({ id: row.id, groupId: row.groupId, system: row.system[0], teacher: teacher[0], tau,
      categories: labels, reason: row.response.result.images.find(image => image.id === row.response.result.ranking[0]).reason });
  }
  const hits = comparisons.reduce((sum, row) => sum + row.top1, 0), n = comparisons.length;
  return { n: rows.length, valid: n, agreement: n ? hits / n : null, agreement95: wilson(hits, n),
    tau: n ? comparisons.reduce((sum, row) => sum + row.tau, 0) / n : null,
    tauBootstrap95: bootstrap(comparisons.map(row => [row]), sample => sample.reduce((sum, row) => sum + row.tau, 0) / sample.length),
    comparisons, disagreements, typeCounts };
}

function summarizeC(rows, baseRows) {
  const base = new Map(baseRows.map(row => [row.id, row])), comparisons = [];
  for (const row of rows) {
    const original = base.get(row.baseId);
    if (!row.response.valid || !original?.response.valid) continue;
    const first = semanticRanking(original), second = semanticRanking(row), tau = kendall(first, second);
    comparisons.push({ id: row.baseId, top1: Number(first[0] === second[0]), tau,
      unreliable: first[0] !== second[0] || tau < 0.8, first: first[0], second: second[0],
      baseFirstPositionWins: first[0] === original.unitIds[0], reversedFirstPositionWins: second[0] === row.unitIds[0],
      expectedFirstPositionProbability: 1 / row.unitIds.length });
  }
  const n = comparisons.length, hits = comparisons.reduce((sum, row) => sum + row.top1, 0);
  const tau = n ? comparisons.reduce((sum, row) => sum + row.tau, 0) / n : null, ci = wilson(hits, n);
  return { n, top1Agreement: n ? hits / n : null, top1Agreement95: ci, tau,
    tauBootstrap95: bootstrap(comparisons.map(row => [row]), sample => sample.reduce((sum, row) => sum + row.tau, 0) / sample.length),
    reliable: n === 30 && hits / n >= 0.9 && ci.low >= 0.8 && tau >= 0.8,
    unstableGroups: comparisons.filter(row => row.unreliable).map(row => row.id), comparisons,
    firstPosition: { baseWins: comparisons.filter(row => row.baseFirstPositionWins).length,
      reversedWins: comparisons.filter(row => row.reversedFirstPositionWins).length,
      randomExpectedWins: comparisons.reduce((sum, row) => sum + row.expectedFirstPositionProbability, 0) } };
}

async function report() {
  const plan = await json(file('plan'));
  const events = (await readFile(path.join(CACHE, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const state = budgetState(events), summary = { plan, spent: state.spent, reserved: state.reserved,
    accounted: state.spent + state.reserved, unresolvedRequests: state.active.size, models: [] };
  for (const model of plan.models) {
    const data = {};
    for (const phase of ['a', 'b', 'c']) {
      let rows;
      try { rows = await json(file(`${phase}-${model}`)); }
      catch (error) { if (error.code === 'ENOENT') { data[phase] = null; continue; } throw error; }
      const ids = new Set(rows.map(row => row.response.requestId));
      const calls = events.filter(event => event.type === 'response' && ids.has(event.requestId));
      const balance = { billedCalls: calls.length, validLabels: rows.filter(row => row.response.valid).length,
        costCny: calls.reduce((sum, event) => sum + event.costCny, 0),
        rawJsonRate: calls.filter(event => event.rawValid ?? event.valid).length / calls.length };
      balance.meanCostCny = balance.costCny / rows.length;
      data[phase] = { rows, balance };
    }
    summary.models.push({ model, a: data.a ? { ...summarizeA(data.a.rows), ...data.a.balance } : null,
      b: data.b ? { ...summarizeB(data.b.rows), ...data.b.balance } : null,
      c: data.c && data.b ? { ...summarizeC(data.c.rows, data.b.rows), ...data.c.balance } : null });
  }
  await atomicJSON(file('summary'), summary);
  console.log(JSON.stringify(summary, null, 2));
  await qa(summary);
}

async function qa(summary) {
  const root = '/tmp/w11-teacher-qa/expanded';
  await mkdir(root, { recursive: true });
  const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const sections = [], sheets = [];
  for (const entry of summary.models) {
    if (!entry.b) continue;
    const rows = await json(file(`b-${entry.model}`)), byId = new Map(rows.map(row => [row.id, row]));
    for (const disagreement of entry.b.disagreements) {
      const row = byId.get(disagreement.id), teacher = semanticRanking(row), inputs = [], cards = [];
      const tested = entry.c?.comparisons.find(item => item.id === row.id);
      const reliability = tested ? (tested.unreliable ? '顺序测试不可靠' : '顺序测试稳定') : '未做顺序测试';
      for (const [i, image] of row.images.entries()) {
        const photo = await sharp(await thumbnail(image.path, image.sha256)).resize(180, 180, { fit: 'contain', background: '#fff' })
          .jpeg().toBuffer();
        const badge = `I${i + 1} S${row.system.indexOf(row.unitIds[i]) + 1} T${teacher.indexOf(row.unitIds[i]) + 1}`;
        const svg = Buffer.from(`<svg width="180" height="20"><rect width="180" height="20" fill="white"/>`
          + `<text x="4" y="15" font-size="12">${badge}</text></svg>`);
        const tile = await sharp({ create: { width: 180, height: 200, channels: 3, background: '#fff' } })
          .composite([{ input: photo, top: 0, left: 0 }, { input: svg, top: 180, left: 0 }]).jpeg().toBuffer();
        inputs.push({ input: tile, left: (i % 4) * 180, top: 30 + Math.floor(i / 4) * 200 });
        cards.push(`<figure><img src="data:image/jpeg;base64,${photo.toString('base64')}"><figcaption>${badge}</figcaption></figure>`);
      }
      const height = 30 + Math.ceil(row.images.length / 4) * 200;
      const title = Buffer.from(`<svg width="720" height="30"><rect width="720" height="30" fill="white"/>`
        + `<text x="8" y="21" font-size="14">${escape(row.id)} S=system T=teacher</text></svg>`);
      const jpeg = await sharp({ create: { width: 720, height, channels: 3, background: '#fff' } })
        .composite([{ input: title, left: 0, top: 0 }, ...inputs]).jpeg().toBuffer();
      const filename = `${entry.model}-${row.id}.jpg`;
      await writeFile(path.join(root, filename), jpeg, { mode: 0o600 });
      sheets.push({ input: jpeg, height });
      sections.push(`<section><h2>${escape(row.id)} ${escape(entry.model)}：${reliability}</h2>`
        + `<p>${escape(row.groupId)}；${escape(disagreement.categories.join('、'))}；老师理由：${escape(disagreement.reason)}</p>`
        + `<p>系统首选 ${escape(disagreement.system)}；老师首选 ${escape(disagreement.teacher)}</p><div>${cards.join('')}</div></section>`);
    }
  }
  // Bound each contact page to eight groups, preserving every image without a giant raster allocation.
  for (let start = 0; start < sheets.length; start += 8) {
    const page = sheets.slice(start, start + 8), height = Math.max(...page.map(sheet => sheet.height));
    await sharp({ create: { width: 1440, height: height * Math.ceil(page.length / 2), channels: 3, background: '#ddd' } })
      .composite(page.map((sheet, i) => ({ input: sheet.input, left: (i % 2) * 720, top: Math.floor(i / 2) * height })))
      .jpeg({ quality: 90 }).toFile(path.join(root, `contact-${Math.floor(start / 8) + 1}.jpg`));
  }
  await atomicJSON(path.join(root, 'disagreements.json'), summary.models.map(entry => ({ model: entry.model,
    disagreements: entry.b?.disagreements || [], stability: entry.c })));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>扩大验证分歧</title>'
    + '<style>body{font-family:sans-serif}section{border-top:1px solid #aaa}figure{margin:8px}div{display:flex;flex-wrap:wrap}</style>'
    + '<h1>扩大验证分歧</h1><p>理由归类为关键词自动归纳，并非人工真值。顺序不稳定组结论不可靠。</p>'
    + sections.join(''), { mode: 0o600 });
}

export async function main(argv) {
  const [command, model] = argv, index = argv.indexOf('--budget-rmb');
  sharp.concurrency(1); sharp.cache({ memory: 32, files: 0, items: 20 });
  if (command === 'prepare') await prepare();
  else if (command === 'report') await report();
  else if (['a', 'b', 'c'].includes(command)) await run(command, model, Number(argv[index + 1]), argv.includes('--enable'));
  else throw new Error('Use prepare, report, or a/b/c <selected model> --enable --budget-rmb 100');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
