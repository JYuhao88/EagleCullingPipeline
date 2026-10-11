#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { CACHE, atomicJSON, withTeacher, thumbnail, budgetState } from './teacher-label.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
const order = entries => [...entries].sort((a, b) => hash(`teacher-v1:${a.id}`).localeCompare(hash(`teacher-v1:${b.id}`)));
const TASK = '挑选同组中最值得保留的照片，给完整排序和每张决定。';

export function samplePairs(manifest) {
  const types = [...new Set(manifest.pairs.map(pair => pair.degradation))].sort();
  const strata = types.map(type => order(manifest.pairs.filter(pair => pair.degradation === type)));
  const result = [];
  for (let round = 0; result.length < 40; round++) {
    let added = false;
    for (const stratum of strata) {
      if (stratum[round] && result.length < 40) { result.push(stratum[round]); added = true; }
    }
    if (!added) throw new Error('Insufficient pairs');
  }
  return result;
}

export function kendall(a, b) {
  if (a.length !== b.length || new Set(a).size !== a.length || !a.every(id => b.includes(id))) throw new Error('Invalid rankings');
  let concordant = 0, discordant = 0;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    if (b.indexOf(a[i]) < b.indexOf(a[j])) concordant++; else discordant++;
  }
  return (concordant - discordant) / (concordant + discordant);
}

async function prepare() {
  const manifest = await json('test/fixtures/bench-syn-manifest.json');
  const imageById = new Map(manifest.images.map(image => [image.id, image]));
  const pairs = samplePairs(manifest);
  const a = pairs.map((pair, i) => {
    const ids = i % 2 ? [pair.degradedId, pair.sourceId] : [pair.sourceId, pair.degradedId];
    return { id: `A${String(i + 1).padStart(2, '0')}`, task: TASK, type: pair.degradation,
      expected: `I${ids.indexOf(pair.sourceId) + 1}`, pairId: pair.id,
      images: ids.map(id => ({ path: path.join('data/cache/bench/syn', imageById.get(id).path),
        sha256: imageById.get(id).sha256 })) };
  });
  // The approved source identity remains in ignored local config, never in public source.
  const config = await json('config/local.json');
  const source = config.aihub?.authorizedRunResults;
  if (typeof source !== 'string' || source.includes('未删减')) throw new Error('Configure the approved historical run locally');
  const run = await json(source);
  if (run.units.length !== 291) throw new Error('Unexpected authorized run');
  const results = new Map(run.results.map(result => [result.unitId, result]));
  const b = order(run.groups.filter(group => group.unitIds.length > 1)).slice(0, 20).map((group, i) => {
    const unitIds = order(group.unitIds.map(id => ({ id }))).map(entry => entry.id);
    return { id: `B${String(i + 1).padStart(2, '0')}`, groupId: group.id, task: TASK, unitIds,
      system: [...group.ranking].sort((a, b) => a.rank - b.rank).map(entry => entry.unitId),
      images: unitIds.map(id => ({ path: results.get(id).previewPath })) };
  });
  await mkdir(CACHE, { recursive: true });
  await atomicJSON(path.join(CACHE, 'pilot-a-input.json'), a);
  await atomicJSON(path.join(CACHE, 'pilot-b-input.json'), b);
  console.log(JSON.stringify({ a: a.length, b: b.length, types: new Set(a.map(group => group.type)).size }));
}

async function run(phase, model, budget, enabled) {
  const groups = await json(path.join(CACHE, `pilot-${phase}-input.json`));
  const file = path.join(CACHE, `pilot-${phase}-${model}.json`);
  const rows = [];
  await withTeacher({ model, budget, enabled }, async label => {
    for (const group of groups) {
      let response;
      try { response = await label(group); }
      catch (error) {
        if (!error.requestId) throw error;
        response = { requestId: error.requestId, model, valid: false, result: null,
          error: error.failureKind || 'json-retries-exhausted' };
      }
      rows.push({ ...group, response });
      await atomicJSON(file, rows);
      console.log(JSON.stringify({ phase, model, processed: rows.length, valid: response.valid, cached: !!response.cached }));
    }
  });
}

async function report() {
  const config = await json('config/local.json');
  const ledger = (await readFile(path.join(CACHE, 'ledger.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const responses = ledger.filter(event => event.type === 'response');
  const state = budgetState(ledger);
  const summary = { a: [], b: [], costCny: state.spent, reservedCny: state.reserved,
    unresolvedRequests: state.active.size, accountedCny: state.spent + state.reserved };
  for (const model of Object.keys(config.aihub.pricing)) {
    for (const phase of ['a', 'b']) {
      let rows;
      try { rows = await json(path.join(CACHE, `pilot-${phase}-${model}.json`)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const requestIds = new Set(rows.map(row => row.response.requestId));
      const calls = responses.filter(event => requestIds.has(event.requestId));
      const row = { model, attempted: rows.length, completed: rows.filter(group => group.response.valid).length, calls: calls.length,
        costCny: calls.reduce((sum, event) => sum + event.costCny, 0),
        meanLatencyMs: calls.reduce((sum, event) => sum + event.latencyMs, 0) / rows.length,
        jsonValidRate: calls.filter(event => event.rawValid ?? event.valid).length / calls.length,
        labelValidRate: calls.filter(event => event.valid).length / calls.length,
        failedGroups: rows.filter(group => !group.response.valid).length };
      row.meanCostCny = row.costCny / rows.length;
      if (phase === 'a') {
        row.correct = rows.filter(group => group.response.result?.ranking[0] === group.expected).length;
        row.accuracy = row.correct / rows.length;
        row.byType = {};
        for (const group of rows) {
          const stat = row.byType[group.type] ??= { n: 0, correct: 0 };
          stat.n++; stat.correct += Number(group.response.result?.ranking[0] === group.expected);
        }
      } else {
        row.agreement = 0; row.tau = 0; row.disagreements = []; row.failedIds = [];
        for (const group of rows) {
          if (!group.response.valid) { row.failedIds.push(group.id); continue; }
          const teacher = group.response.result.ranking.map(id => group.unitIds[Number(id.slice(1)) - 1]);
          row.agreement += Number(teacher[0] === group.system[0]);
          row.tau += kendall(group.system, teacher);
          if (teacher[0] !== group.system[0]) row.disagreements.push({ id: group.id, groupId: group.groupId,
            system: group.system[0], teacher: teacher[0],
            reason: group.response.result.images.find(image => image.id === group.response.result.ranking[0]).reason });
        }
        row.agreement /= rows.length; row.tau /= rows.length - row.failedGroups;
      }
      summary[phase].push(row);
    }
  }
  await atomicJSON(path.join(CACHE, 'pilot-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  const qa = '/tmp/w11-teacher-qa';
  await mkdir(qa, { recursive: true });
  const panels = [];
  const sections = [];
  const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  for (const model of summary.b) {
    const groups = await json(path.join(CACHE, `pilot-b-${model.model}.json`));
    for (const disagreement of model.disagreements) {
      const group = groups.find(group => group.id === disagreement.id);
      const photos = [];
      const teacher = group.response.result.ranking.map(id => group.unitIds[Number(id.slice(1)) - 1]);
      const cards = [];
      for (const [i, id] of group.unitIds.entries()) {
        const image = group.images[i];
        const jpeg = await sharp(await thumbnail(image.path)).resize(180, 180, { fit: 'contain', background: '#fff' })
          .jpeg().toBuffer();
        const badge = `I${i + 1} S${group.system.indexOf(id) + 1} T${teacher.indexOf(id) + 1}`;
        const caption = Buffer.from(`<svg width="180" height="20"><rect width="180" height="20" fill="white"/>`
          + `<text x="4" y="15" font-size="13">${badge}</text></svg>`);
        photos.push(await sharp({ create: { width: 180, height: 200, channels: 3, background: '#fff' } })
          .composite([{ input: jpeg, top: 0, left: 0 }, { input: caption, top: 180, left: 0 }]).jpeg().toBuffer());
        cards.push(`<figure><img src="data:image/jpeg;base64,${jpeg.toString('base64')}"><figcaption>`
          + `${escape(badge)} ${escape(id)}</figcaption></figure>`);
      }
      const title = `${model.model} ${group.id} | S=system rank T=teacher rank`;
      const svg = Buffer.from(`<svg width="720" height="30"><rect width="720" height="30" fill="white"/>`
        + `<text x="8" y="21" font-size="14">${title}</text></svg>`);
      const height = 30 + Math.ceil(photos.length / 4) * 200;
      const panel = await sharp({ create: { width: 720, height, channels: 3, background: '#fff' } })
        .composite([{ input: svg, top: 0, left: 0 }, ...photos.map((input, i) => ({ input,
          top: 30 + Math.floor(i / 4) * 200, left: (i % 4) * 180 }))]).jpeg().toBuffer();
      panels.push({ input: panel, height });
      sections.push(`<section><h2>${escape(model.model)} ${escape(group.id)}</h2><p>${escape(group.groupId)}</p>`
        + `<p>系统首选 ${escape(disagreement.system)}；老师首选 ${escape(disagreement.teacher)}；`
        + `老师理由：${escape(disagreement.reason)}</p><div>${cards.join('')}</div></section>`);
    }
  }
  if (panels.length) {
    const columns = 2, rows = Math.ceil(panels.length / columns), height = Math.max(...panels.map(panel => panel.height));
    await sharp({ create: { width: 720 * columns, height: height * rows, channels: 3, background: '#ddd' } })
      .composite(panels.map((panel, i) => ({ input: panel.input, left: (i % columns) * 720, top: Math.floor(i / columns) * height })))
      .jpeg({ quality: 90 }).toFile(path.join(qa, 'disagreements.jpg'));
  }
  await atomicJSON(path.join(qa, 'disagreements.json'), summary.b);
  await writeFile(path.join(qa, 'index.html'), '<!doctype html><meta charset="utf-8"><title>老师分歧核对</title>'
    + '<style>body{font-family:sans-serif}section{border-top:1px solid #aaa}figure{display:inline-block;margin:8px}'
    + 'figcaption{font-size:12px}section div{display:flex;flex-wrap:wrap}</style>'
    + '<h1>老师分歧核对</h1><p>S 为系统名次，T 为老师名次；照片编号与请求一致。老师偏好不是用户真值。</p>'
    + sections.join(''), { mode: 0o600 });
}

export async function main(argv) {
  const [command, model] = argv;
  const budgetIndex = argv.indexOf('--budget-rmb');
  sharp.concurrency(1); sharp.cache({ memory: 32, files: 0, items: 20 });
  if (command === 'prepare') await prepare();
  else if (command === 'report') await report();
  else if (command === 'a-all') {
    const config = await json('config/local.json');
    for (const name of Object.keys(config.aihub.pricing)) {
      await run('a', name, Number(argv[budgetIndex + 1]), argv.includes('--enable'));
    }
  } else if (command === 'b-best') {
    const summary = await json(path.join(CACHE, 'pilot-summary.json'));
    if (summary.a.length !== 4 || summary.a.some(row => row.attempted !== 40)) throw new Error('A must finish before model selection');
    const best = [...summary.a].sort((a, b) => b.accuracy - a.accuracy || a.meanCostCny - b.meanCostCny)[0];
    const economical = summary.a.filter(row => row.accuracy >= best.accuracy - 0.05)
      .sort((a, b) => a.meanCostCny - b.meanCostCny)[0];
    const selected = [...new Set([best.model, economical.model])];
    await atomicJSON(path.join(CACHE, 'pilot-selection.json'), {
      selected, method: 'highest accuracy (cost tie break), plus cheapest within 5 percentage points',
    });
    for (const name of selected) await run('b', name, Number(argv[budgetIndex + 1]), argv.includes('--enable'));
  }
  else if (['a', 'b'].includes(command)) {
    await run(command, model, Number(argv[budgetIndex + 1]), argv.includes('--enable'));
  } else throw new Error('Use prepare, a-all/b-best/a/b with --enable --budget-rmb 30, or report');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
