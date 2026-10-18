#!/usr/bin/env node
// Model-notes trial: for large groups, send the cluster representatives (small, metadata-free JPEGs) with our own
// measurements to a vision model and ask only for located observations the measurements cannot see.
// prepare writes the requests; scripts/aihub-ray.py runs them on Ray; ingest bills them and draws one review
// sheet per group. Never touches ranking, decisions or Eagle.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { readManifest, readRows } from '../src/core/segmented-results.js';
import { photoFacts } from '../src/core/photo-facts.js';
import { clusterGroup } from './eagle-native.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'data/cache/model-notes');
const MODEL = 'gemini-3.8-flash';
const LABELS = ['A', 'B', 'C', 'D'];

export function factsText(facts) {
  if (!facts) return '无测量';
  return [facts.eyes === 'open' ? '主体睁眼' : facts.eyes === 'closed' ? '主体闭眼' : '',
    facts.cuts?.length ? `${facts.cuts.join('、')}被画面边切到` : '', facts.blur ? '可能模糊' : '',
    facts.tilted ? '画面歪' : ''].filter(Boolean).join('，') || '没有测出问题';
}

const schema = { type: 'object', additionalProperties: false, required: ['photos', 'difference'], properties: {
  photos: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['label', 'notes'],
    properties: { label: { type: 'string', enum: LABELS }, notes: { type: 'array', maxItems: 2, items: {
      type: 'object', additionalProperties: false, required: ['text', 'tone'],
      properties: { text: { type: 'string', maxLength: 24 }, tone: { type: 'string', enum: ['good', 'bad', 'neutral'] } } } } } } },
  difference: { type: 'string', maxLength: 40 } } };

export function prompt(reps) {
  return `这是同一场拍摄里相近的 ${reps.length} 张人像，标为 ${LABELS.slice(0, reps.length).join('、')}。`
    + `程序已测量：${reps.map((rep, i) => `${LABELS[i]}：${factsText(rep.facts)}`).join('；')}。\n`
    + '请只补充测量看不到、但选片时有用的观察：表情和神态、视线方向、手和姿势是否自然、'
    + '背景里的杂物或穿帮（例如杆子从头后长出、路人、垃圾桶）、主体和背景是否分得开。\n'
    + '要求：每条必须说出具体部位或位置；不打分、不评价整体好坏、不推荐留哪张；不要重复上面的测量；'
    + '没有值得说的就给空数组；每张最多 2 条，每条不超过 20 个字，用简体中文。'
    + 'difference 用一句话说这几张之间最主要的区别（不超过 30 字），没有明显区别就给空字符串。';
}

async function jpeg(file) {
  const resolved = await realpath(file);
  const root = await realpath(path.join(ROOT, 'data/cache/previews'));
  if (!resolved.startsWith(root + path.sep)) throw new Error('Preview outside the preview cache');
  const output = await sharp(await readFile(resolved), { limitInputPixels: 60e6 }).rotate()
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb')
    .jpeg({ quality: 80 }).toBuffer();
  const metadata = await sharp(output).metadata();
  if (metadata.exif || metadata.xmp || metadata.iptc) throw new Error('Metadata remained');
  return output;
}

const escape = text => String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function sheet(group, file) {
  const width = 360, imageHeight = 480, textHeight = 150;
  const tiles = await Promise.all(group.reps.map(async (rep, i) => {
    const image = await sharp(await readFile(rep.previewPath)).rotate()
      .resize({ width, height: imageHeight, fit: 'contain', background: '#202124' }).toBuffer();
    const lines = [`${LABELS[i]}  ${rep.name}  第 ${rep.rank} 名`, factsText(rep.facts),
      ...rep.notes.map(note => `${{ good: '+', bad: '×', neutral: '·' }[note.tone]} ${note.text}`)];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${textHeight}">`
      + `<rect width="100%" height="100%" fill="#202124"/>${lines.map((line, n) => `<text x="10" y="${24 + n * 26}" `
      + `font-family="PingFang SC, sans-serif" font-size="${n ? 17 : 18}" fill="${n === 1 ? '#9aa0a6' : '#e8eaed'}">`
      + `${escape(line)}</text>`).join('')}</svg>`;
    return [{ input: image, left: i * width, top: 0 }, { input: Buffer.from(svg), left: i * width, top: imageHeight }];
  }));
  const footer = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * group.reps.length}" height="44">`
    + `<rect width="100%" height="100%" fill="#2d2e31"/><text x="10" y="29" font-family="PingFang SC, sans-serif" `
    + `font-size="18" fill="#fdd663">区别：${escape(group.difference || '（无）')}</text></svg>`;
  await sharp({ create: { width: width * group.reps.length, height: imageHeight + textHeight + 44, channels: 3,
    background: '#202124' } }).composite([...tiles.flat(), { input: Buffer.from(footer), left: 0, top: imageHeight + textHeight }])
    .jpeg({ quality: 82 }).toFile(file);
}

const digest = value => createHash('sha256').update(value).digest('hex');

async function loadRun(runId) {
  const runDirectory = path.join(ROOT, 'data/runs', runId);
  const manifest = await readManifest(runDirectory);
  const data = { results: [], groups: [] };
  for (const kind of Object.keys(data)) for await (const row of readRows(runDirectory, manifest, kind)) data[kind].push(row);
  return data;
}

async function prepare(runId, work) {
  const data = await loadRun(runId);
  const results = new Map(data.results.map(row => [row.unitId, row]));
  const meta = [], requests = [];
  for (const group of data.groups) {
    const clusters = clusterGroup(group.unitIds.map(id => results.get(id)).filter(Boolean));
    if (!clusters) continue;
    const rank = new Map((group.ranking || []).map(row => [row.unitId, row.rank]));
    const reps = clusters.map(cluster => cluster[0]).slice(0, LABELS.length).sort((a, b) => rank.get(a.unitId) - rank.get(b.unitId))
      .map(result => ({ unitId: result.unitId, name: result.name, rank: rank.get(result.unitId),
        previewPath: result.previewPath, facts: photoFacts(result) }));
    if (reps.length < 2) continue;
    const content = [{ type: 'text', text: prompt(reps) }];
    for (const [i, rep] of reps.entries()) {
      const image = await jpeg(rep.previewPath);
      content.push({ type: 'text', text: LABELS[i] },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } });
    }
    const id = digest(JSON.stringify(content.map(part => part.type === 'image_url' ? digest(part.image_url.url) : part.text)));
    requests.push({ id, body: { model: MODEL, max_completion_tokens: 2048, messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: 'photo_notes', schema } } } });
    meta.push({ id, groupId: group.id, units: group.unitIds.length, reps });
  }
  await writeFile(path.join(work, 'requests.jsonl'), requests.map(row => JSON.stringify(row) + '\n').join(''));
  await writeFile(path.join(work, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta.length;
}

async function ingest(work) {
  const teacher = await readFile(path.join(ROOT, 'data/cache/teacher/ledger.jsonl'), 'utf8');
  const price = teacher.trim().split('\n').map(line => JSON.parse(line)).find(event => event.model === MODEL && event.pricing)?.pricing;
  if (!price) throw new Error('No saved unit price for the model');
  const meta = JSON.parse(await readFile(path.join(work, 'meta.json'), 'utf8'));
  const rows = (await readFile(path.join(work, 'results.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const byId = new Map(rows.map(row => [row.id, row]));
  const out = [], failures = [];
  let cost = 0;
  await writeFile(path.join(work, 'ledger.jsonl'), '', { mode: 0o600 });
  for (const [index, group] of meta.entries()) {
    const row = byId.get(group.id);
    let answer = null;
    try { answer = row?.status === 200 ? JSON.parse(row.content) : null; } catch { /* counted below */ }
    if (row?.usage) {
      const tokens = (row.usage.prompt_tokens || 0) * price.input + (row.usage.completion_tokens || 0) * price.output;
      const spent = tokens / 1e6 * price.usdToCny;
      cost += spent;
      await appendFile(path.join(work, 'ledger.jsonl'), JSON.stringify({ type: 'response', requestId: group.id, model: MODEL,
        usage: row.usage, costCny: spent, valid: Boolean(answer), result: answer, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    if (!answer) { failures.push({ groupId: group.groupId, status: row?.status ?? null, error: row?.error?.slice(0, 120) }); continue; }
    const notes = new Map((answer.photos || []).map(photo => [photo.label, photo.notes || []]));
    const entry = { groupId: group.groupId, units: group.units, difference: answer.difference || '',
      reps: group.reps.map((rep, i) => ({ ...rep, label: LABELS[i], notes: notes.get(LABELS[i]) || [] })) };
    out.push(entry);
    await sheet(entry, path.join(work, `sheet-${index + 1}.jpg`));
  }
  await writeFile(path.join(work, 'notes.json'), JSON.stringify(out.map(entry => ({ ...entry,
    reps: entry.reps.map(({ previewPath, ...rep }) => rep) })), null, 2));
  return { groups: out.length, failures, costCny: Number(cost.toFixed(3)) };
}

async function main() {
  const [command, runId] = process.argv.slice(2);
  if (!['prepare', 'ingest'].includes(command) || !runId) throw new Error('用法：node scripts/model-notes.mjs prepare|ingest <runId>');
  const work = path.join(CACHE, runId);
  await mkdir(work, { recursive: true });
  if (command === 'prepare') console.log(JSON.stringify({ requests: await prepare(runId, work), work: path.relative(ROOT, work) }));
  else console.log(JSON.stringify(await ingest(work)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
