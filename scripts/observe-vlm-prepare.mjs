#!/usr/bin/env node
// Prepare the fixed local-VLM evaluation corpus.  This script only reads the
// existing teacher cache and the already sanitised p0 views; it never calls a
// model service.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { binary, parseAnswer, POSITIVE, QUESTIONS } from './observe-teacher.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_P0 = path.join(ROOT, 'data/cache/observe/p0');
const DEFAULT_PANEL = path.join(ROOT, 'data/cache/observe/p1-panel');
const DEFAULT_TRAIN = path.join(ROOT, 'data/cache/observe/p1-oi');
const DEFAULT_RUN = path.join(ROOT, 'data/runs/run-1184317d-aadd-467e-b280-6f0d6ed81e86');
const DEFAULT_OUT = path.join(ROOT, 'data/cache/w34-vlm/prepared');
const TEACHERS = ['flash', 'gpt', 'claude'];
const SCOPES = Object.fromEntries(Object.entries(QUESTIONS).map(([key, value]) => [key, value.scope]));
const ACTION_RANK = { rejected: 1, candidate: 2, selected: 3 };

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export const readJsonl = async file => {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
};
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const writeJsonl = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fileSha256 = async file => sha256(await readFile(file));

export function relativePath(value, { jpeg = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || (jpeg && !/\.jpe?g$/i.test(value))) throw new Error(`invalid relative ${jpeg ? 'JPEG' : 'path'}`);
  return value;
}

function teacherName(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('flash')) return 'flash';
  if (name.includes('gpt')) return 'gpt';
  if (name.includes('claude')) return 'claude';
  throw new Error(`unknown teacher model: ${model}`);
}

function imageQuestions(item) {
  const hasFace = Boolean(item.images?.face);
  const hasScene = item.set === 'photos' || item.set === 'openimages';
  // The Open Images reference panel was paid for with the four face questions
  // only.  Keeping scene questions out of its manifest avoids measuring an
  // attribute with no teacher votes.
  if (item.set === 'openimages') return hasFace ? ['smile', 'mouth', 'eyes', 'gaze'] : [];
  return Object.keys(QUESTIONS).filter(key => SCOPES[key] === 'face' ? hasFace : hasScene);
}

function normalizeTruth(truth) {
  return { smile: typeof truth?.smile === 'boolean' ? truth.smile : null,
    mouth: typeof truth?.mouth === 'boolean' ? truth.mouth : null };
}

function parsedVotes(answers) {
  const out = {};
  for (const [key, option] of Object.entries(answers || {})) {
    const value = binary(key, option);
    out[key] = value == null ? null : value;
  }
  return out;
}

/** Normalize a cached teacher result without retaining usage, prompts, or paths. */
export function normalizeTeacherResult(row) {
  const [itemId, model, rawAsk] = String(row.id || '').split('|');
  if (!itemId || !model || !/^\d+$/.test(rawAsk || '')) return null;
  const answers = row.status === 200 ? (parseAnswer(row.content) || {}) : {};
  return { item_id: itemId, teacher: teacherName(model), ask: Number(rawAsk),
    content: typeof row.content === 'string' ? row.content : '', status: row.status ?? null,
    answers, votes: parsedVotes(answers) };
}

async function loadTeacherResults(dir) {
  const rows = await readJsonl(path.join(dir, 'results.jsonl'));
  return rows.map(normalizeTeacherResult).filter(Boolean);
}

function mergeLabels(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.item_id}|${row.teacher}|${row.ask}`;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.item_id.localeCompare(b.item_id)
    || a.teacher.localeCompare(b.teacher) || a.ask - b.ask);
}

function votesForItem(item, labels) {
  const byQuestion = {};
  const wanted = new Set(item.questions);
  for (const row of labels.filter(label => label.item_id === item.id)) {
    for (const [key, value] of Object.entries(row.votes || {})) {
      if (!wanted.has(key)) continue;
      const question = byQuestion[key] ||= {};
      const values = question[row.teacher] ||= [];
      values[row.ask] = value;
    }
  }
  for (const question of Object.values(byQuestion)) for (const values of Object.values(question)) {
    const last = values.length;
    for (let i = 0; i < last; i++) if (values[i] === undefined) values[i] = null;
  }
  return byQuestion;
}

async function validateAndCopyImage(source, destination, kind) {
  const metadata = await sharp(source).metadata();
  const edge = Math.max(metadata.width || 0, metadata.height || 0);
  if (!metadata.width || !metadata.height || metadata.format !== 'jpeg' || edge > 768
    || metadata.hasProfile || metadata.hasAlpha || metadata.exif || metadata.icc || metadata.xmp) {
    throw new Error(`p0 image is not a sanitised JPEG: ${source}`);
  }
  if (kind === 'face' && (metadata.width !== 384 || metadata.height !== 384)) {
    throw new Error(`p0 face crop must be 384x384: ${source}`);
  }
  if (kind === 'full' && edge > 768) throw new Error(`p0 full image exceeds 768px: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const [before, after] = await Promise.all([fileSha256(source), fileSha256(destination)]);
  if (before !== after) throw new Error(`p0 image changed while copying: ${source}`);
  return { bytes: (await readFile(destination)).byteLength, sha256: after, width: metadata.width, height: metadata.height };
}

async function prepareP0(p0Dir, outputDir, labels) {
  const sourceItems = await readJsonl(path.join(p0Dir, 'items.jsonl'));
  const imageStats = [], items = [];
  const seen = new Set();
  for (const source of sourceItems) {
    if (!source.id || seen.has(source.id)) throw new Error(`duplicate p0 item: ${source.id}`);
    seen.add(source.id);
    const images = {};
    for (const kind of ['full', 'face']) {
      if (!source.images?.[kind]) continue;
      const rel = relativePath(source.images[kind], { jpeg: true });
      const input = path.resolve(p0Dir, rel);
      if (!input.startsWith(path.resolve(p0Dir) + path.sep)) throw new Error('p0 image escapes cache');
      const target = path.join(outputDir, 'p0', rel);
      const stat = await validateAndCopyImage(input, target, kind);
      images[kind] = path.posix.join('p0', rel);
      imageStats.push({ item: source.id, kind, path: images[kind], ...stat });
    }
    const item = { id: source.id, set: source.set, questions: imageQuestions(source), images,
      storage: 'package', votes: {}, truth: normalizeTruth(source.truth), stratum: source.stratum ?? null,
      ...(Number.isFinite(source.faceHeight) ? { faceHeight: source.faceHeight } : {}) };
    item.votes = votesForItem(item, labels);
    items.push(item);
  }
  return { items, imageStats };
}

function safeRemoteItem(source) {
  const imageRoot = relativePath(source.imageRoot || '');
  const images = {};
  for (const kind of ['full', 'face']) if (source.images?.[kind]) images[kind] = relativePath(source.images[kind], { jpeg: true });
  if (!images.full || !images.face) throw new Error(`remote item lacks full/face view: ${source.id}`);
  return { id: source.id, set: source.set || 'openimages', questions: imageQuestions({ ...source, images }), images,
    storage: 'ceph', imageRoot, votes: {}, truth: normalizeTruth(source.truth), stratum: source.stratum ?? null,
    ...(Array.isArray(source.faceBox) ? { faceHeight: source.faceBox[3] - source.faceBox[1] } : {}) };
}

async function prepareP1(panelDir, trainDir, labels) {
  const sourceItems = await readJsonl(path.join(panelDir, 'items.jsonl'));
  const items = sourceItems.map(safeRemoteItem);
  for (const item of items) item.votes = votesForItem(item, labels);
  return { items };
}

function photoId(unitId) { return `photo-${sha256(unitId).slice(0, 12)}`; }

function choosePair(group, decisions, p0ById, index) {
  const available = group.unitIds.map(unitId => {
    const id = photoId(unitId), decision = decisions.get(unitId);
    return decision && p0ById.has(id) && p0ById.get(id).images.full ? { unitId, id, decision } : null;
  }).filter(Boolean);
  const categories = [...new Set(available.map(x => x.decision.action))].filter(action => ACTION_RANK[action]);
  if (categories.length < 2) return null;
  categories.sort((a, b) => ACTION_RANK[b] - ACTION_RANK[a]);
  const high = available.filter(x => x.decision.action === categories[0])
    .sort((a, b) => sha256(`${group.id}|${a.unitId}`).localeCompare(sha256(`${group.id}|${b.unitId}`)))[0];
  const low = available.filter(x => x.decision.action === categories[1])
    .sort((a, b) => sha256(`${group.id}|${a.unitId}`).localeCompare(sha256(`${group.id}|${b.unitId}`)))[0];
  if (!high || !low) return null;
  const pairHash = sha256(`${group.id}|${high.unitId}|${low.unitId}`);
  const preferredSide = index % 2 === 0 ? 'left' : 'right';
  const left = preferredSide === 'left' ? high : low, right = preferredSide === 'left' ? low : high;
  const acceptedAi = available.some(({ decision }) => decision.reason === '接受 AI 建议');
  return { id: `group-${pairHash.slice(0, 16)}`, kind: 'group', set: 'group', questions: [],
    images: { left: p0ById.get(left.id).images.full, right: p0ById.get(right.id).images.full }, storage: 'package',
    truth: preferredSide, preferred: preferredSide, decisionSource: 'human weak preference', acceptedAi,
    sourceGroupId: group.id, actions: { left: left.decision.action, right: right.decision.action } };
}

export function buildGroups(reviewSummary, decisionsRows, p0Items, maxGroups = 24) {
  const p0ById = new Map(p0Items.map(item => [item.id, item]));
  const decisions = new Map(decisionsRows.map(row => [row.unitId, row]));
  const candidates = reviewSummary.filter(group => Array.isArray(group.unitIds) && group.unitIds.length > 1)
    .map(group => ({ group, hash: sha256(group.id) })).sort((a, b) => a.hash.localeCompare(b.hash));
  const groups = [];
  for (const { group } of candidates) {
    const pair = choosePair(group, decisions, p0ById, groups.length);
    if (pair) groups.push(pair);
    if (groups.length >= maxGroups) break;
  }
  return groups;
}

async function loadGroupInputs(runDir) {
  if (!runDir) return { review: [], decisions: [] };
  const [review, decisions] = await Promise.all([
    readJson(path.join(runDir, 'review-summary.json')).catch(() => []),
    readJson(path.join(runDir, 'decisions.json')).catch(() => []),
  ]);
  return { review: Array.isArray(review) ? review : [], decisions: Array.isArray(decisions) ? decisions : [] };
}

export async function buildPrepared({ outputDir = DEFAULT_OUT, p0Dir = DEFAULT_P0, p1PanelDir = DEFAULT_PANEL,
  p1TrainDir = DEFAULT_TRAIN, runDir = DEFAULT_RUN, maxGroups = 24 } = {}) {
  const out = path.resolve(outputDir);
  for (const source of [p0Dir, p1PanelDir, p1TrainDir, runDir]) {
    const input = path.resolve(source), images = path.join(out, 'p0');
    if (out === input || out.startsWith(input + path.sep) || images === input
      || input.startsWith(images + path.sep)) throw new Error('output directory overlaps source cache');
  }
  await mkdir(out, { recursive: true });
  const [p0Results, panelResults, trainResults, p0Items, p1SourceItems, groupInputs] = await Promise.all([
    loadTeacherResults(p0Dir), loadTeacherResults(p1PanelDir), loadTeacherResults(p1TrainDir),
    readJsonl(path.join(p0Dir, 'items.jsonl')), readJsonl(path.join(p1PanelDir, 'items.jsonl')), loadGroupInputs(runDir),
  ]);
  const wanted = new Set([...p0Items, ...p1SourceItems].map(item => item.id));
  if (!p0Items.length || !p1SourceItems.length) throw new Error('both evaluation item caches are required');
  const labels = mergeLabels([...p0Results, ...panelResults, ...trainResults])
    .filter(row => wanted.has(row.item_id));
  const p0 = await prepareP0(p0Dir, out, labels);
  const p1 = await prepareP1(p1PanelDir, p1TrainDir, labels);
  const groups = buildGroups(groupInputs.review, groupInputs.decisions, p0.items, maxGroups);
  const items = [...p0.items, ...p1.items, ...groups];
  const questions = { questions: QUESTIONS, positive: POSITIVE, teachers: TEACHERS };
  await writeJson(path.join(out, 'questions.json'), questions);
  await writeJson(path.join(out, 'items.json'), items);
  await writeJson(path.join(out, 'manifest.json'), items);
  await writeJsonl(path.join(out, 'items.jsonl'), items);
  await writeJsonl(path.join(out, 'manifest.jsonl'), items);
  await writeJson(path.join(out, 'labels.json'), labels);
  await writeJsonl(path.join(out, 'labels.jsonl'), labels);
  const counts = {
    items: items.length, p0: p0.items.length, p1Panel: p1.items.length, groups: groups.length,
    bySet: Object.fromEntries([...new Set(items.map(item => item.set))].map(set => [set, items.filter(item => item.set === set).length])),
    labels: labels.length, labelsByTeacher: Object.fromEntries(TEACHERS.map(teacher =>
      [teacher, labels.filter(row => row.teacher === teacher).length])),
  };
  const imageBytes = p0.imageStats.reduce((sum, row) => sum + row.bytes, 0);
  const summary = { schemaVersion: 1, counts, integrity: {
    p0Images: p0.imageStats.length, p0Bytes: imageBytes, p0Sha256: p0.imageStats.map(row => row.sha256),
    metadataStripped: true, fullMaxEdge: Math.max(0, ...p0.imageStats.filter(row => row.kind === 'full')
      .map(row => Math.max(row.width, row.height))),
    faceSizes: [...new Set(p0.imageStats.filter(row => row.kind === 'face').map(row => `${row.width}x${row.height}`))],
    remoteRoot: p1.items[0]?.imageRoot ?? null,
  }, groups: { candidates: groupInputs.review.filter(row => row.unitIds?.length > 1).length, selected: groups.length,
    acceptedAi: groups.filter(row => row.acceptedAi).length },
    sources: { p0: path.basename(p0Dir), p1Panel: path.basename(p1PanelDir), p1Train: path.basename(p1TrainDir) } };
  await writeJson(path.join(out, 'summary.json'), summary);
  return { outputDir: out, items, labels, groups, summary };
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUT, p0Dir: DEFAULT_P0, p1PanelDir: DEFAULT_PANEL, p1TrainDir: DEFAULT_TRAIN,
    runDir: DEFAULT_RUN, maxGroups: 24 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (key === '--output') args.outputDir = value;
    else if (key === '--p0') args.p0Dir = value;
    else if (key === '--p1-panel') args.p1PanelDir = value;
    else if (key === '--p1-train') args.p1TrainDir = value;
    else if (key === '--run') args.runDir = value;
    else if (key === '--max-groups') args.maxGroups = Number(value);
    else throw new Error(`unknown option: ${key}`);
  }
  if (!Number.isInteger(args.maxGroups) || args.maxGroups < 0 || args.maxGroups > 1000) throw new Error('invalid max-groups');
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await buildPrepared(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ output: path.relative(ROOT, result.outputDir), ...result.summary.counts,
      groups: result.summary.groups }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
