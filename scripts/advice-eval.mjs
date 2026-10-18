#!/usr/bin/env node
// Reference-advice check. Does not change ranking, rules, or Eagle.
// Images must already be a local sample; remote calls need --enable.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { detectPose } from '../src/core/pose.js';
import { evaluateRules } from '../src/core/rules-engine.js';
import { computeSignals } from '../src/core/signals.js';
import { ask as askAihub } from './aihub-ask.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'data/cache/advice-eval');
const SHARPNESS = new Set(['P-FACE-FOCUS', 'G-PROXY-BLUR', 'L-FOCUS-REQUIRED', 'G-FOCUS-REQUIRED']);
const WORSE = { violate: 3, warn: 2, pass: 1, na: 0 };
const ask = options => askAihub({ ...options, cache: CACHE });
const digest = value => createHash('sha256').update(value).digest('hex');

const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));

function collect(file, source, rows) {
  const out = [];
  for (const row of rows) {
    const kind = row.kind || '';
    const supports = ['source', 'issue', 'praise'].includes(kind) || ['positive', 'negative'].includes(row.polarity);
    const challenge = kind === 'exception' || kind === 'counterpoint';
    if (supports || challenge) out.push({ ruleId: row.ruleId, source, challenge });
  }
  return out;
}

export function consensusReport(files) {
  const items = [];
  for (const [source, data] of Object.entries(files)) {
    if (Array.isArray(data.evidence)) items.push(...collect(source, source, data.evidence));
    for (const rule of data.rules || []) {
      items.push(...collect(source, source, (rule.evidence || []).map(row => ({ ...row, ruleId: rule.id }))));
    }
  }
  const rules = new Map();
  for (const item of items) {
    const rule = rules.get(item.ruleId) || { ruleId: item.ruleId, sources: new Set(), challenges: new Set() };
    if (item.challenge) rule.challenges.add(item.source);
    else rule.sources.add(item.source);
    rules.set(item.ruleId, rule);
  }
  const rows = [...rules.values()].map(rule => {
    const status = rule.challenges.size ? 'contested'
      : rule.sources.size >= 2 ? 'consensus' : rule.sources.size === 1 ? 'single' : 'unknown';
    return { ruleId: rule.ruleId, status, sources: [...rule.sources].sort(), challenges: [...rule.challenges].sort() };
  });
  const counts = Object.fromEntries(['consensus', 'contested', 'single'].map(status =>
    [status, rows.filter(row => row.status === status).length]));
  return { counts, rows };
}

async function measure(sample) {
  const index = await readJSON(path.join(sample, 'index.json'));
  const files = [];
  const add = name => { if (name) files.push({ id: name, filePath: path.join(sample, name) }); };
  for (const pair of index.pairs || []) { add(pair.files?.a); add(pair.files?.b); }
  for (const row of index.yidao || []) add(row.file);
  const unique = [...new Map(files.map(file => [file.filePath, file])).values()];
  const posed = await detectPose(unique, { size: 1 });
  const byFile = new Map(unique.map((file, i) => [file.filePath, posed[i]]));
  const rowsFor = result => {
    if (!result?.available) return [];
    return evaluateRules(computeSignals({ ...result, imageMeasurements: result.imageMeasurements }), { genres: ['portrait'] });
  };
  const pairs = (index.pairs || []).map(pair => {
    const sides = {};
    for (const label of ['a', 'b']) {
      const file = pair.files?.[label];
      const result = file ? byFile.get(path.join(sample, file)) : null;
      const rows = result ? rowsFor(result) : [];
      const target = rows.find(row => row.ruleId === pair.rule);
      sides[label] = { verdict: target?.verdict || 'na', evidence: target?.evidence || '',
        advice: rows.filter(row => ['violate', 'warn'].includes(row.verdict) && !SHARPNESS.has(row.ruleId)).slice(0, 6) };
    }
    const bad = pair.positive === 'a' ? 'b' : 'a';
    const directed = WORSE[sides[bad].verdict] > WORSE[sides[pair.positive].verdict];
    return { id: pair.id, rule: pair.rule, positive: pair.positive, directed, sides };
  });
  const yidao = (index.yidao || []).map(row => {
    const result = byFile.get(path.join(sample, row.file));
    const rows = result ? rowsFor(result) : [];
    return { ...row, advice: rows.filter(item => ['violate', 'warn'].includes(item.verdict) && !SHARPNESS.has(item.ruleId)).slice(0, 8) };
  });
  return { pairs, yidao };
}

async function jpeg(file) {
  const resolved = await realpath(file);
  const root = await realpath('/tmp/w27-advice/sample');
  if (!resolved.startsWith(root + path.sep)) throw new Error('Image outside the reference sample');
  const { data, info } = await sharp(await readFile(resolved), { limitInputPixels: 20e6 }).rotate()
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(data, { raw: info }).jpeg({ quality: 80 }).toBuffer();
  const metadata = await sharp(output).metadata();
  if (metadata.exif || metadata.xmp || metadata.iptc || metadata.icc) throw new Error('Metadata remained');
  return output;
}

const pairSchema = { type: 'object', additionalProperties: false, required: ['better', 'because'],
  properties: { better: { type: 'string', enum: ['A', 'B', 'tie'] }, because: { type: 'string', maxLength: 40 } } };
const textSchema = { type: 'object', additionalProperties: false, required: ['same', 'missed'],
  properties: {
    same: { type: 'integer', enum: [0, 1, 2] },
    missed: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 24 } },
  } };

export async function judge(measured, { model, budget }) {
  const pairs = [];
  for (const pair of measured.pairs) {
    const order = digest(pair.id).charCodeAt(0) % 2 ? ['b', 'a'] : ['a', 'b'];
    const images = [];
    for (const label of order) {
      const file = pair.sides[label].file;
      if (!file) throw new Error('Missing pair image');
      images.push(await jpeg(file));
    }
    const result = await ask({ model, budget, schema: pairSchema, messages: [
      { type: 'text', text: `这两张是教学截图，不能代表原片清晰度。规则：${pair.text}。哪一张更符合这条规则的好例子？只回答JSON。` },
      { type: 'text', text: 'A' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${images[0].toString('base64')}` } },
      { type: 'text', text: 'B' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${images[1].toString('base64')}` } },
    ] });
    const chosen = result.better === 'tie' ? 'tie' : order[result.better === 'A' ? 0 : 1];
    pairs.push({ id: pair.id, rule: pair.rule, chosen, expected: pair.positive, agree: chosen === pair.positive });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const yidao = [];
  for (const row of measured.yidao) {
    const advice = row.advice.map(item => `${item.ruleId}:${item.evidence}`).join('；') || '无';
    const result = await ask({ model, budget, schema: textSchema, messages: [{ type: 'text',
      text: `忽略清晰度、对焦和噪点。专家原文：${row.text}\n系统建议：${advice}\n系统是否说到专家的其他主要问题？same=2主要说到，1部分，0没有。` }] });
    yidao.push({ id: row.id, tier: row.tier, same: result.same, advice: row.advice.length });
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return { pairs, yidao };
}

async function main() {
  const command = process.argv[2];
  await mkdir(CACHE, { recursive: true });
  if (command === 'consensus') {
    const dir = path.join(ROOT, 'src/rules/candidates');
    const files = {};
    for (const name of ['book', 'course', 'paper', 'wulin', 'existing'].map(kind => `${kind}-evidence.json`)) {
      files[name.replace('-evidence.json', '')] = await readJSON(path.join(dir, name));
    }
    const report = consensusReport(files);
    await writeFile(path.join(CACHE, 'consensus.json'), JSON.stringify(report));
    console.log(JSON.stringify(report.counts));
    return;
  }
  if (command === 'measure') {
    const report = await measure(process.argv[3]);
    await writeFile(path.join(CACHE, 'measured.json'), JSON.stringify(report));
    const directed = report.pairs.filter(pair => pair.directed).length;
    const withAdvice = report.yidao.filter(row => row.advice.length).length;
    console.log(JSON.stringify({ pairs: report.pairs.length, directed, yidao: report.yidao.length, withAdvice }));
    return;
  }
  if (command === 'judge') {
    if (!process.argv.includes('--enable')) throw new Error('Remote check requires --enable');
    const budget = Number(process.argv[process.argv.indexOf('--budget-rmb') + 1]);
    const measured = await readJSON(path.join(CACHE, 'measured.json'));
    const index = await readJSON(path.join(process.argv[3], 'index.json'));
    const files = new Map();
    for (const pair of index.pairs || []) for (const label of ['a', 'b']) files.set(pair.id + label, pair.files?.[label]);
    for (const pair of measured.pairs) for (const label of ['a', 'b']) pair.sides[label].file = files.get(pair.id + label)
      ? path.join(process.argv[3], files.get(pair.id + label)) : null;
    const report = await judge(measured, { model: 'gemini-3.8-flash', budget });
    await writeFile(path.join(CACHE, 'judge.json'), JSON.stringify(report));
    const agree = report.pairs.filter(pair => pair.agree).length;
    const same = report.yidao.filter(row => row.same >= 1).length;
    console.log(JSON.stringify({ pairAgree: agree, pairs: report.pairs.length, yidaoMentioned: same, yidao: report.yidao.length }));
    return;
  }
  throw new Error('Use consensus, measure <sample>, or judge <sample> --enable --budget-rmb 20');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
