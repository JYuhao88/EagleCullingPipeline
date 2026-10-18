#!/usr/bin/env node
// Phase 0 of local AI observations: ask teacher models fixed attribute questions about public human-labelled faces
// and about the user's photos, then measure how stable and how accurate each teacher is. Everything stays in
// data/cache/observe/<name>; the Ray job is submitted separately with scripts/aihub-ray.py.
//
//   celeba <name> <samples.jsonl>    CelebA test faces collected by scripts/celeba-sample-ray.py (evaluation only)
//   photos <name> <runId>            whole photo (long edge 768) plus the main face crop from the run's previews
//   remote <name> <manifest.jsonl> [imageRoot]  Open Images already stored on Ceph; no local images
//   requests <name> <budgetCny> [model:asks,...] [question,...]
//   report <name> | table <name> | labels <name>
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readManifest, readRows } from '../src/core/segmented-results.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PREVIEWS = path.join(ROOT, 'data/cache/previews');
const DEFAULT_IMAGE_ROOT = 'photography/eagle-culling/observe/openimages-v1';
const DEFAULT_LEDGER = path.join(ROOT, 'data/cache/teacher/ledger.jsonl');
const DEFAULT_MODELS = 'gemini-3.8-flash:3,gpt-6-sol:1,claude-opus-5-5:1';
const PROMPT_SCHEMA = new Set(['claude-opus-5-5']);

export const QUESTIONS = {
  smile: { scope: 'face', text: '主体是否在笑',
    options: { big: '明显笑（露齿或嘴角明显上扬）', slight: '微笑', none: '没有笑', unsure: '看不清' } },
  mouth: { scope: 'face', text: '主体的嘴', options: { open: '张开', slight: '微张', closed: '闭合', unsure: '看不清' } },
  eyes: { scope: 'face', text: '主体的眼睛', options: { open: '睁开', half: '半闭', closed: '闭上', unsure: '看不清' } },
  natural: { scope: 'face', text: '主体的表情', options: { relaxed: '自然放松', stiff: '僵硬或刻意', unsure: '看不清' } },
  gaze: { scope: 'face', text: '主体的视线', options: { camera: '看镜头', away: '看别处', unsure: '看不清' } },
  others: { scope: 'scene', text: '画面中主体以外的人',
    options: { none: '没有其他人', quiet: '有其他人但不分散注意力', distracting: '有其他人且分散注意力', unsure: '看不清' } },
  clutter: { scope: 'scene', text: '背景', options: { clean: '干净', busy: '略杂', cluttered: '杂乱抢眼', unsure: '看不清' } },
  merger: { scope: 'scene', text: '是否有物体从主体头部或身体后方“长出来”（如杆子、树枝）',
    options: { no: '没有', yes: '有', unsure: '看不清' } },
  separation: { scope: 'scene', text: '主体和背景', options: { clear: '分离清楚', merged: '粘连（颜色或明暗接近）', unsure: '看不清' } },
};
// The answer each binary observation reports as "yes"; 看不清 is an abstention, not a "no".
export const POSITIVE = { smile: ['big', 'slight'], mouth: ['open', 'slight'], eyes: ['half', 'closed'], natural: ['stiff'],
  gaze: ['camera'], others: ['distracting'], clutter: ['cluttered'], merger: ['yes'], separation: ['merged'] };

const work = name => path.join(ROOT, 'data/cache/observe', name.replace(/[^\w.-]/g, '_'));
const digest = value => createHash('sha256').update(value).digest('hex');
const readJsonl = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const writeJsonl = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row) + '\n').join(''));

function random(seed) {
  let state = parseInt(digest(seed).slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (list, next) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

// Re-encoded from raw pixels: no EXIF, XMP, IPTC or ICC reaches the model.
async function saveImage(dir, input, { edge, square } = {}) {
  let image = sharp(input).rotate();
  if (square) image = image.resize(square, square, { fit: 'fill', kernel: 'lanczos3' });
  else if (edge) image = image.resize(edge, edge, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const jpeg = await sharp(data, { raw: info }).jpeg({ quality: 90 }).toBuffer();
  const name = `images/${digest(jpeg).slice(0, 16)}.jpg`;
  await writeFile(path.join(dir, name), jpeg);
  return name;
}

async function addItems(dir, items) {
  const file = path.join(dir, 'items.jsonl');
  const kept = (await readJsonl(file)).filter(row => !items.some(item => item.id === row.id));
  await writeJsonl(file, [...kept, ...items]);
  return kept.length + items.length;
}

async function celeba(name, samples) {
  const dir = work(name), items = [];
  await mkdir(path.join(dir, 'images'), { recursive: true });
  for (const row of await readJsonl(samples)) {
    items.push({ id: `celeba-${row.index}`, set: 'celeba', images: { face: await saveImage(dir, Buffer.from(row.jpeg, 'base64')) },
      truth: { smile: row.smile, mouth: row.mouth } });
  }
  const total = await addItems(dir, items);
  console.log(JSON.stringify({ celeba: items.length, smiling: items.filter(i => i.truth.smile).length,
    mouthOpen: items.filter(i => i.truth.mouth).length, total }));
}

const overlap = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? (w * h) / ((a[2] - a[0]) * (a[3] - a[1])) : 0;
};

async function photos(name, runId) {
  const dir = work(name), runDir = path.join(ROOT, 'data/runs', runId);
  await mkdir(path.join(dir, 'images'), { recursive: true });
  const manifest = await readManifest(runDir), items = [];
  for await (const row of readRows(runDir, manifest, 'results')) {
    const preview = path.resolve(ROOT, row.previewPath || '');
    if (!preview.startsWith(PREVIEWS + path.sep)) continue;
    const main = (row.signals?.persons || []).find(person => person.isMain);
    const face = (row.faces || []).filter(f => Array.isArray(f.box) && (!main || overlap(f.box, main.box) > 0.5))
      .sort((a, b) => (b.box[3] - b.box[1]) - (a.box[3] - a.box[1]))[0];
    const images = { full: await saveImage(dir, preview, { edge: 768 }) };
    if (face) {
      const { width, height } = await sharp(preview).metadata();
      const [x0, y0, x1, y1] = face.box;
      const side = Math.floor(Math.min(width, height, 1.8 * Math.max((x1 - x0) * width, (y1 - y0) * height)));
      const left = Math.round(Math.min(width - side, Math.max(0, (x0 + x1) / 2 * width - side / 2)));
      const top = Math.round(Math.min(height - side, Math.max(0, (y0 + y1) / 2 * height - side / 2)));
      const crop = await sharp(preview).extract({ left, top, width: side, height: side }).toBuffer();
      images.face = await saveImage(dir, crop, { square: 384 });
    }
    const share = face ? face.box[3] - face.box[1] : null;
    const hour = Number(String(row.exif?.dateTimeOriginal || '').match(/ (\d{2}):/)?.[1]);
    items.push({ id: `photo-${digest(row.unitId).slice(0, 12)}`, set: 'photos', images,
      ...(share == null ? {} : { faceHeight: Math.round(share * 1e4) / 1e4 }),
      stratum: { face: share == null ? 'none' : share < 0.08 ? 'small' : share < 0.13 ? 'mid' : 'large',
        night: Number.isFinite(hour) ? hour >= 18 || hour < 6 : null },
      local: face?.eyesAssessed ? { eyes: Boolean(face.eyesClosed) } : {} });
  }
  const total = await addItems(dir, items);
  const count = key => items.reduce((acc, item) => ({ ...acc, [item.stratum[key]]: (acc[item.stratum[key]] || 0) + 1 }), {});
  console.log(JSON.stringify({ photos: items.length, face: count('face'), night: count('night'), total }));
}

function relativePath(value, jpeg = false) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(value)
    || (jpeg && !value.endsWith('.jpg'))) throw new Error(`Invalid relative ${jpeg ? 'JPEG path' : 'imageRoot'}`);
  return value;
}

export async function remote(name, manifestFile, imageRoot = DEFAULT_IMAGE_ROOT, { dir = work(name) } = {}) {
  relativePath(imageRoot);
  const source = await readFile(manifestFile, 'utf8');
  const rows = source.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set();
  const items = rows.map(row => {
    if (typeof row.id !== 'string' || !/^[\w-]+$/.test(row.id) || seen.has(row.id)) {
      throw new Error('Open Images ids must be unique and contain only letters, digits, underscores or hyphens');
    }
    seen.add(row.id);
    const stratum = typeof row.stratum === 'string' ? { face: row.stratum } : row.stratum;
    if (!['small', 'mid', 'large'].includes(stratum?.face)) throw new Error('Missing Open Images face stratum');
    return { id: `openimages-${row.id}`, set: 'openimages', imageRoot,
      images: { full: relativePath(row.full, true), face: relativePath(row.face, true) },
      stratum, license: row.license, author: row.author, originalUrl: row.originalUrl,
      faceBox: row.faceBox, faces: row.faces, persons: row.persons };
  });
  await mkdir(dir, { recursive: true });
  const total = await addItems(dir, items);
  console.log(JSON.stringify({ openimages: items.length, imageRoot, total }));
}

function requestImageRoot(items) {
  const remote = items.filter(item => item.set === 'openimages');
  if (!remote.length) return undefined;
  if (remote.length !== items.length) throw new Error('Use separate observation names for local and remote images');
  const roots = new Set(remote.map(item => relativePath(item.imageRoot)));
  if (roots.size !== 1) throw new Error('All remote items must use the same imageRoot');
  for (const item of remote) for (const image of Object.values(item.images)) relativePath(image, true);
  return [...roots][0];
}

export function prompt(keys, item, order) {
  const intro = item.set === 'celeba' ? '图是一张人脸照片，主体就是这个人。'
    : item.images.face ? '图 1 是整张照片；图 2 是从同一张照片裁出的主体人物脸部。' : '图是整张照片。';
  const lines = keys.map(key => `${key}：${QUESTIONS[key].text}。选项：${order[key].join(' / ')}`);
  return ['你在给照片做标注。只根据图里看得见的内容作答，看不清就选“看不清”，不要猜。', intro,
    '每个问题只能从列出的选项里原样选一个，输出一个 JSON 对象，键是问题编号。', ...lines].join('\n');
}

export async function requests(name, budget, spec = DEFAULT_MODELS, questions,
  { dir = work(name), ledgerFile = DEFAULT_LEDGER } = {}) {
  const asked = questions ? questions.split(',') : Object.keys(QUESTIONS);
  if (asked.some(key => !QUESTIONS[key])) throw new Error('Unknown question');
  const items = await readJsonl(path.join(dir, 'items.jsonl')), imageRoot = requestImageRoot(items);
  const teacher = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const models = spec.split(',').map(part => part.split(':')).map(([model, asks]) => ({ model, asks: Number(asks) || 1 }));
  const pricing = Object.fromEntries(models.map(({ model }) => [model, teacher.find(e => e.model === model && e.pricing)?.pricing]));
  if (Object.values(pricing).some(price => !price)) throw new Error('No saved unit price for a selected model');
  const rows = [];
  for (const item of items) {
    const keys = asked.filter(key => QUESTIONS[key].scope === 'face' ? item.images.face
      : ['photos', 'openimages'].includes(item.set));
    for (const { model, asks } of models) {
      for (let ask = 0; ask < asks; ask++) {
        const next = random(`${item.id}|${model}|${ask}`);
        const order = Object.fromEntries(keys.map(key => [key, shuffle(Object.values(QUESTIONS[key].options), next)]));
        const schema = { type: 'object', additionalProperties: false, required: keys,
          properties: Object.fromEntries(keys.map(key => [key, { type: 'string', enum: order[key] }])) };
        const text = prompt(keys, item, order) + (PROMPT_SCHEMA.has(model)
          ? `\n只输出 JSON 对象，不要代码块或其他文字。JSON 结构：${JSON.stringify(schema)}` : '');
        const content = [{ type: 'text', text }, ...['full', 'face'].filter(kind => item.images[kind])
          .map(kind => ({ type: 'image_url', image_file: item.images[kind] }))];
        rows.push({ id: `${item.id}|${model}|${ask}`, body: { model, max_completion_tokens: 2000,
          messages: [{ role: 'user', content }],
          ...(PROMPT_SCHEMA.has(model) ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'observe', schema } } }) } });
      }
    }
  }
  await writeJsonl(path.join(dir, 'requests.jsonl'), shuffle(rows, random(name)));
  const concurrency = Object.fromEntries(models.map(({ model }) => [model, model.includes('flash') ? 4 : 2]));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ budgetCny: Number(budget), pricing, concurrency,
    pauseSeconds: 1, timeoutSeconds: 4 * 3600, ...(imageRoot ? { imageRoot } : {}) }, null, 2));
  console.log(JSON.stringify({ requests: rows.length, items: items.length, models, budgetCny: Number(budget) }));
}

export function parseAnswer(content) {
  const text = String(content || '').replace(/```(?:json)?/g, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const out = {};
  for (const [key, question] of Object.entries(QUESTIONS)) {
    if (!(key in raw)) continue;
    const value = String(raw[key]).trim();
    const option = Object.entries(question.options).find(([id, label]) => label === value || id === value)?.[0];
    if (option) out[key] = option;
  }
  return out;
}

// Stricter readings of an asked question, scored against the same truth (CelebA "Smiling" may exclude slight smiles).
export const VARIANTS = { smileBig: { from: 'smile', positive: ['big'] }, mouthOpen: { from: 'mouth', positive: ['open'] } };
const source = key => VARIANTS[key]?.from ?? key;
export const binary = (key, option) => option == null || option === 'unsure' ? null
  : (VARIANTS[key]?.positive ?? POSITIVE[key]).includes(option) ? 1 : 0;

export function kappa(pairs) {
  const both = pairs.filter(([a, b]) => a != null && b != null);
  if (both.length < 10) return null;
  const n = both.length, agree = both.filter(([a, b]) => a === b).length / n;
  const pa = both.filter(([a]) => a === 1).length / n, pb = both.filter(([, b]) => b === 1).length / n;
  const chance = pa * pb + (1 - pa) * (1 - pb);
  return { n, agree: +agree.toFixed(3), kappa: chance === 1 ? null : +((agree - chance) / (1 - chance)).toFixed(3) };
}

function score(pairs) {
  const both = pairs.filter(([guess, truth]) => guess != null && truth != null);
  const tp = both.filter(([g, t]) => g === 1 && t === 1).length, fp = both.filter(([g, t]) => g === 1 && t === 0).length;
  const fn = both.filter(([g, t]) => g === 0 && t === 1).length;
  return { n: both.length, coverage: +(both.length / Math.max(1, pairs.length)).toFixed(3),
    accuracy: both.length ? +(both.filter(([g, t]) => g === t).length / both.length).toFixed(3) : null,
    precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, precisionLow: tp + fp ? +wilsonLow(tp, tp + fp).toFixed(3) : null,
    recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
}

/** Lower end of the 95% Wilson interval, the launch gate's bound. */
export function wilsonLow(hits, n, z = 1.96) {
  const p = hits / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

const ratio = (part, whole) => +(part / Math.max(1, whole)).toFixed(3);

// One item's binary votes for one question: the cheap teacher's repeated asks, each strong teacher, and the panel
// (cheap majority plus every strong teacher), which only speaks when all of them give the same non-abstaining answer.
export function votes(key, item, answers, cheap, strong) {
  const asked = source(key);
  const pick = (model, ask = 0) => binary(key, answers.get(`${item.id}|${model}|${ask}`)?.[asked]);
  const asks = [0, 1, 2].map(ask => answers.get(`${item.id}|${cheap}|${ask}`)?.[asked]).filter(Boolean);
  const cheapVotes = asks.map(option => binary(key, option));
  const known = cheapVotes.filter(v => v != null), ones = known.filter(v => v === 1).length, zeros = known.length - ones;
  const majority = ones >= 2 ? 1 : zeros >= 2 ? 0 : null;
  const strongVotes = Object.fromEntries(strong.map(model => [model, pick(model)]));
  const panel = [majority, ...Object.values(strongVotes)];
  return { item, asked: asks.length > 0, flipped: asks.length === 3 ? new Set(cheapVotes).size > 1 : null,
    single: pick(cheap), majority, unanimous: known.length === 3 && (ones === 0 || zeros === 0) ? majority : null,
    strong: strongVotes, panel: panel.every(v => v != null) && new Set(panel).size === 1 ? panel[0] : null,
    truth: item.truth?.[asked] == null ? null : item.truth[asked] ? 1 : 0,
    local: item.local?.[asked] == null ? null : item.local[asked] ? 1 : 0 };
}

function summarize(rows, cheap, strong) {
  const flips = rows.filter(row => row.flipped != null), decided = rows.filter(row => row.majority != null);
  const pairs = [...strong.map(model => [`${cheap}~${model}`, rows.map(row => [row.majority, row.strong[model]])]),
    ...strong.slice(1).map(model => [`${strong[0]}~${model}`, rows.map(row => [row.strong[strong[0]], row.strong[model]])])];
  const entry = { n: rows.length, flipRate: ratio(flips.filter(row => row.flipped).length, flips.length),
    positiveRate: ratio(decided.filter(row => row.majority === 1).length, decided.length),
    panelCoverage: ratio(rows.filter(row => row.panel != null).length, rows.length),
    kappa: Object.fromEntries(pairs.map(([label, list]) => [label, kappa(list)])) };
  if (rows.some(row => row.truth != null)) {
    const against = field => score(rows.map(row => [typeof field === 'function' ? field(row) : row[field], row.truth]));
    entry.truth = { single: against('single'), majority: against('majority'), unanimous: against('unanimous'),
      ...Object.fromEntries(strong.map(model => [model, against(row => row.strong[model])])), panel: against('panel') };
  }
  if (rows.some(row => row.local != null)) entry.localRule = kappa(rows.map(row => [row.local, row.panel ?? row.majority]));
  return entry;
}

const GROUPS = { all: () => true, small: item => item.stratum?.face === 'small', mid: item => item.stratum?.face === 'mid',
  large: item => item.stratum?.face === 'large', night: item => item.stratum?.night === true,
  day: item => item.stratum?.night === false };

export async function report(name, { dir = work(name) } = {}) {
  const items = await readJsonl(path.join(dir, 'items.jsonl'));
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  const answers = new Map(), calls = {};
  let cost = 0;
  for (const row of await readJsonl(path.join(dir, 'results.jsonl'))) {
    const [item, model, ask] = row.id.split('|');
    const stats = calls[model] ||= { ok: 0, invalid: 0, failed: 0, cny: 0 };
    const price = config.pricing[model], usage = row.usage || {};
    const cny = ((usage.prompt_tokens || 0) * price.input + (usage.completion_tokens || 0) * price.output) / 1e6 * price.usdToCny;
    stats.cny += cny; cost += cny;
    const parsed = row.status === 200 ? parseAnswer(row.content) : null;
    if (row.status !== 200) stats.failed++; else if (!parsed || !Object.keys(parsed).length) stats.invalid++; else stats.ok++;
    if (parsed) answers.set(`${item}|${model}|${ask}`, parsed);
  }
  const models = Object.keys(config.pricing), cheap = models.find(model => model.includes('flash'));
  const strong = models.filter(model => model !== cheap);
  const out = { costCny: +cost.toFixed(2), calls, sets: {} };
  for (const set of ['celeba', 'photos', 'openimages']) {
    const members = items.filter(item => item.set === set);
    if (!members.length) continue;
    out.sets[set] = {};
    for (const key of [...Object.keys(QUESTIONS), ...Object.keys(VARIANTS)]) {
      const rows = members.map(item => votes(key, item, answers, cheap, strong)).filter(row => row.asked);
      const groups = set === 'celeba' ? ['all'] : Object.keys(GROUPS);
      const result = Object.fromEntries(groups.map(group => [group, rows.filter(row => GROUPS[group](row.item))])
        .filter(([, subset]) => subset.length >= 10).map(([group, subset]) => [group, summarize(subset, cheap, strong)]));
      if (Object.keys(result).length) out.sets[set][key] = result;
    }
  }
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
}

/** Per item and question, every model's binary answers in ask order (null = 看不清 or missing), for training heads. */
export async function labels(name, { dir = work(name) } = {}) {
  const items = await readJsonl(path.join(dir, 'items.jsonl'));
  const answers = new Map();
  for (const row of await readJsonl(path.join(dir, 'results.jsonl'))) {
    const parsed = row.status === 200 ? parseAnswer(row.content) : null;
    if (!parsed) continue;
    const [item, model, ask] = row.id.split('|');
    const list = answers.get(item) || new Map();
    list.set(`${model}|${ask}`, parsed);
    answers.set(item, list);
  }
  const rows = items.map(item => {
    const asked = answers.get(item.id) || new Map(), out = {};
    for (const key of [...Object.keys(QUESTIONS), ...Object.keys(VARIANTS)]) {
      const byModel = {};
      for (const [id, parsed] of asked) {
        const [model, ask] = id.split('|'), option = parsed[source(key)];
        if (option === undefined) continue;
        (byModel[model] ||= [])[Number(ask)] = binary(key, option);
      }
      if (Object.keys(byModel).length) out[key] = byModel;
    }
    return { id: item.id, set: item.set, stratum: item.stratum, faceHeight: item.faceHeight, truth: item.truth,
      local: item.local, votes: out };
  });
  await writeJsonl(path.join(dir, 'labels.jsonl'), rows);
  console.log(JSON.stringify({ items: rows.length, answered: rows.filter(row => Object.keys(row.votes).length).length }));
}

/** One line per set, question and group: stability, weakest teacher agreement, panel coverage and truth scores. */
export async function table(name, { dir = work(name) } = {}) {
  const out = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
  const cell = value => value == null ? '-' : String(value);
  const lines = ['set\tquestion\tgroup\tn\tflip\tminKappa\tpanelCov\tpos\tpanelP\tpanelPLow\tpanelR\tsingleAcc'];
  for (const [set, questions] of Object.entries(out.sets)) for (const [key, groups] of Object.entries(questions))
    for (const [group, entry] of Object.entries(groups)) {
      const kappas = Object.values(entry.kappa).map(k => k?.kappa).filter(Number.isFinite);
      const panel = entry.truth?.panel;
      lines.push([set, key, group, entry.n, entry.flipRate, kappas.length ? Math.min(...kappas) : null, entry.panelCoverage,
        entry.positiveRate, panel?.precision, panel?.precisionLow, panel?.recall, entry.truth?.single.accuracy].map(cell).join('\t'));
    }
  console.log(`cost ${out.costCny} CNY\n` + lines.join('\n'));
}

const [command, name, ...rest] = process.argv.slice(2);
const commands = { celeba: () => celeba(name, rest[0]), photos: () => photos(name, rest[0]),
  remote: () => remote(name, rest[0], rest[1]), requests: () => requests(name, rest[0], rest[1], rest[2]),
  report: () => report(name), table: () => table(name), labels: () => labels(name) };
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!commands[command] || !name || (command === 'requests' && !(Number(rest[0]) > 0))
    || (['photos', 'celeba', 'remote'].includes(command) && !rest[0])) {
    console.error('usage: celeba <name> <samples.jsonl> | photos <name> <runId>'
      + ' | requests <name> <budgetCny> [model:asks,...] [question,...]'
      + ' | remote <name> <manifest.jsonl> [imageRoot] | report <name> | table <name> | labels <name>');
    process.exit(2);
  }
  await commands[command]();
}
