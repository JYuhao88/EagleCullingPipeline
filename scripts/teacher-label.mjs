#!/usr/bin/env node
// Standalone, opt-in experiment. Nothing in the production pipeline imports this module.
import { readFile, mkdir, realpath, rename, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const digest = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const CACHE = path.resolve('data/cache/teacher');
const resourceGuard = () => {
  if (process.memoryUsage().rss > 3 * 1024 ** 3) throw new Error('Teacher exceeds 3 GiB memory soft limit');
};
const PROMPT = '比较这些匿名照片，按摄影选片质量从好到差排序。考虑清晰度、曝光、表情、手势、姿态、裁切和构图。'
  + '不要猜人物身份，不输出人名、路径或元数据。每张给保留或淘汰、问题标签和不超过40字中文理由。'
  + '即使各有所长也给完整无并列排序；只返回指定JSON。';
const schema = {
  type: 'object', required: ['ranking', 'images'], additionalProperties: false,
  properties: {
    ranking: { type: 'array', items: { type: 'string' } },
    images: { type: 'array', items: {
      type: 'object', required: ['id', 'decision', 'issues', 'reason'], additionalProperties: false,
      properties: { id: { type: 'string' }, decision: { type: 'string', enum: ['keep', 'reject'] },
        issues: { type: 'array', items: { type: 'string' } }, reason: { type: 'string', maxLength: 40 } },
    } },
  },
};

export function validateLabel(value, ids) {
  const permutation = list => Array.isArray(list) && list.length === ids.length
    && new Set(list).size === ids.length && list.every(id => ids.includes(id));
  if (!value || Object.keys(value).sort().join() !== 'images,ranking' || !permutation(value.ranking)
    || !Array.isArray(value.images) || !value.images.every(image => image && typeof image === 'object')
    || !permutation(value.images.map(image => image.id))) return false;
  return value.images.every(image => Object.keys(image).sort().join() === 'decision,id,issues,reason'
    && ['keep', 'reject'].includes(image.decision) && Array.isArray(image.issues) && image.issues.length <= 20
    && image.issues.every(issue => typeof issue === 'string' && [...issue].length <= 40)
    && typeof image.reason === 'string' && [...image.reason].length <= 40
    && !/https?:|\/Users\/|[\\/]|未删减/.test([image.reason, ...image.issues].join(' ')));
}

export function cost(usage, pricing) {
  if (!usage || !['prompt_tokens', 'completion_tokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) {
    throw new Error('Missing valid usage; reservation must remain outstanding');
  }
  return (usage.prompt_tokens * pricing.input + usage.completion_tokens * pricing.output) / 1e6 * pricing.usdToCny;
}

export function budgetState(events) {
  const active = new Map();
  let spent = 0;
  for (const event of events) {
    if (event.type === 'reserve') {
      if (active.has(event.callId) || !(event.estimateCny > 0 && Number.isFinite(event.estimateCny))) {
        throw new Error('Invalid ledger reservation');
      }
      active.set(event.callId, event);
    }
    else if (event.type === 'response') {
      if (!active.has(event.callId) || !(event.costCny >= 0 && Number.isFinite(event.costCny))) {
        throw new Error('Invalid ledger response');
      }
      active.delete(event.callId);
      spent += event.costCny;
    } else if (event.type === 'rejected') {
      if (!active.has(event.callId) || event.status !== 429) throw new Error('Invalid rejection event');
    } else throw new Error('Unknown ledger event');
  }
  return { spent, reserved: [...active.values()].reduce((sum, event) => sum + event.estimateCny, 0), active };
}

async function durable(file, text, append = false) {
  const handle = await open(file, append ? 'a' : 'w', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await durable(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

export async function thumbnail(file, expectedSha) {
  if (file.includes('未删减')) throw new Error('Forbidden source');
  const resolved = await realpath(file);
  const roots = [await realpath('data/cache/bench/syn'), await realpath('data/cache/previews')];
  if (!roots.some(root => resolved.startsWith(`${root}${path.sep}`))) throw new Error('Source outside approved thumbnail roots');
  const source = await readFile(resolved);
  resourceGuard();
  if (expectedSha && digest(source) !== expectedSha) throw new Error('Source checksum mismatch');
  // Sharp drops metadata by default. Decode to pixels first, then construct a fresh JPEG encoder.
  const { data, info } = await sharp(source, { limitInputPixels: 40e6 }).rotate()
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const jpeg = await sharp(data, { raw: info }).jpeg({ quality: 85 }).toBuffer();
  const metadata = await sharp(jpeg).metadata();
  if (Math.max(metadata.width, metadata.height) > 768 || metadata.exif || metadata.xmp || metadata.iptc || metadata.icc) {
    throw new Error('Thumbnail privacy validation failed');
  }
  return jpeg;
}

export async function withTeacher({ model, budget, enabled }, callback) {
  if (!enabled) throw new Error('Remote experiment requires --enable');
  const totalBudget = Number(process.env.ECP_AIHUB_BUDGET_RMB);
  if (!(budget > 0 && budget <= 100 && totalBudget > 0)) throw new Error('Explicit cumulative budget must be in (0,100]');
  const config = await json('config/local.json');
  const rate = config.aihub?.pricing?.[model];
  const schemaMode = config.aihub?.responseFormat?.[model] !== false;
  const pricing = { ...rate, usdToCny: config.aihub?.usdToCny };
  if (![pricing.input, pricing.output, pricing.usdToCny].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('Configure aihub.pricing[model].input/output and aihub.usdToCny in ignored config/local.json');
  }
  const url = process.env.ECP_AIHUB_URL, key = process.env.ECP_AIHUB_KEY;
  if (!url || !key || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Missing AIHub environment');
  await mkdir(CACHE, { recursive: true });
  const lock = path.join(CACHE, 'lock');
  try { await mkdir(lock); } catch { throw new Error('Teacher ledger locked; audit interrupted owner before removing lock'); }
  try {
    sharp.concurrency(1); sharp.cache({ memory: 32, files: 0, items: 20 });
    const ledger = path.join(CACHE, 'ledger.jsonl');
    let events;
    try { events = (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') events = []; else throw new Error('Ledger corrupt; refusing calls'); }
    const append = async event => { await durable(ledger, `${JSON.stringify(event)}\n`, true); events.push(event); };
    const opening = budgetState(events);
    if (opening.spent + opening.reserved > Math.min(budget, totalBudget)) throw new Error('Cumulative budget already exceeded');
    // Recover a persisted 429 from an older client without releasing its conservative fee reservation.
    for (const event of budgetState(events).active.values()) {
      if (events.some(entry => entry.type === 'rejected' && entry.callId === event.callId)) continue;
      let failure;
      try { failure = await json(path.join(CACHE, `${event.requestId}.http-error.json`)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (failure.callId === event.callId && failure.status === 429) {
        await append({ type: 'rejected', callId: event.callId, requestId: event.requestId, model: event.model,
          status: 429, retryAt: Date.now() + 30000 });
      }
    }
    const label = async group => {
      if (!Array.isArray(group.images) || group.images.length < 2 || group.images.length > 100) throw new Error('Expected 2–100 images');
      if (typeof group.task !== 'string' || group.task.length > 2000
        || /[\\/]|https?:|未删减/.test(group.task)) throw new Error('Task must contain instructions without paths');
      const images = [];
      for (const image of group.images) { resourceGuard(); images.push(await thumbnail(image.path, image.sha256)); }
      const ids = images.map((_, i) => `I${i + 1}`);
      const maxTokens = images.length > 40 ? 12000 : 6000;
      const requestId = digest(JSON.stringify({ version: 1, model, prompt: PROMPT, task: group.task,
        images: images.map(digest), maxTokens, schema, ...(schemaMode ? {} : { schemaMode: false }) }));
      const cached = events.findLast(event => event.requestId === requestId && event.type === 'response' && event.valid);
      if (cached) return { ...cached, cached: true };
      const prior = events.filter(event => event.requestId === requestId && event.type === 'reserve');
      if (prior.some(event => budgetState(events).active.has(event.callId)
        && !events.some(entry => entry.type === 'rejected' && entry.callId === event.callId && entry.status === 429))) {
        throw new Error('Unconfirmed request; audit required');
      }
      for (let attempt = prior.length; attempt < 3; attempt++) {
        const rejection = events.findLast(event => event.requestId === requestId && event.type === 'rejected');
        const lastResponse = events.findLast(event => event.model === model && event.type === 'response');
        const interval = Math.min(60000, Math.max(1000, Number(config.aihub?.minIntervalMs) || 1000));
        const waitMs = Math.max(0, (rejection?.retryAt || 0) - Date.now(),
          lastResponse ? interval - (Date.now() - Date.parse(lastResponse.at)) : 0);
        if (waitMs) await new Promise(resolve => setTimeout(resolve, Math.min(60000, waitMs)));
        const state = budgetState(events);
        resourceGuard();
        // Deliberately conservative image/text allowance; full completion cap includes thinking tokens.
        const estimateCny = cost({ prompt_tokens: images.length * 8192 + 8192, completion_tokens: maxTokens }, pricing);
        if (state.spent + state.reserved + estimateCny > Math.min(budget, totalBudget)) throw new Error('Budget refuses request');
        const callId = randomUUID(), started = Date.now();
        await append({ type: 'reserve', callId, requestId, model, estimateCny, pricing, at: new Date().toISOString() });
        const content = [{ type: 'text', text: `${PROMPT}\n任务：${group.task}`
          + (schemaMode ? '' : `\nJSON结构：${JSON.stringify(schema)}`) }];
        images.forEach((image, i) => content.push({ type: 'text', text: ids[i] },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }));
        let response;
        try {
          response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'user', content }],
              ...(schemaMode ? { response_format: {
                type: 'json_schema', json_schema: { name: 'photo_selection', schema },
              } } : {}) }) });
        } catch { throw new Error('Transport uncertain; reservation retained, no automatic resend'); }
        if (!response.ok) {
          await atomicJSON(path.join(CACHE, `${requestId}.http-error.json`), {
            callId, status: response.status, body: (await response.text()).slice(0, 10000),
          });
          if (response.status === 429) {
            const retryDelay = Math.min(30000, Math.max(1000, Number(config.aihub?.retryDelayMs) || 30000));
            await append({ type: 'rejected', callId, requestId, model, status: 429,
              retryAt: Date.now() + (attempt + 1) * retryDelay });
            if (attempt < 2) continue;
            const error = new Error('Rate limit retries exhausted');
            error.requestId = requestId; error.failureKind = 'rate-limit-retries-exhausted'; throw error;
          }
          throw new Error(`HTTP ${response.status}; local error saved, reservation retained, audit before retry`);
        }
        let body;
        try { body = await response.json(); } catch { throw new Error('Response unreadable; reservation retained'); }
        const usage = { prompt_tokens: body.usage?.prompt_tokens, completion_tokens: body.usage?.completion_tokens };
        const costCny = cost(usage, pricing);
        let result = null;
        const raw = body.choices?.[0]?.message?.content;
        try { result = JSON.parse(raw); } catch { /* bill malformed output too */ }
        const rawValid = validateLabel(result, ids);
        if (!rawValid && typeof raw === 'string' && /^\s*```(?:json)?\s*\n/.test(raw)) {
          try { result = JSON.parse(raw.replace(/^\s*```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '')); } catch { /* invalid */ }
        }
        const valid = validateLabel(result, ids);
        const event = { type: 'response', callId, requestId, model, usage, pricing, costCny,
          latencyMs: Date.now() - started, valid, rawValid, result: valid ? result : null, at: new Date().toISOString() };
        await append(event);
        const settled = budgetState(events);
        if (settled.spent + settled.reserved > Math.min(budget, totalBudget)) throw new Error('Cumulative budget exceeded; stopped');
        if (!rawValid) await atomicJSON(path.join(CACHE, `${callId}.invalid-output.json`), { requestId, raw });
        if (costCny > estimateCny) throw new Error('Usage exceeded conservative reservation; stop and audit budget');
        if (valid) {
          await atomicJSON(path.join(CACHE, `${requestId}.json`), event);
          return event;
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const error = new Error('JSON validation failed after at most two retries');
      error.requestId = requestId;
      if (events.some(event => event.type === 'rejected' && event.requestId === requestId)) {
        error.failureKind = 'rate-limit-retries-exhausted';
      }
      throw error;
    };
    return await callback(label, () => budgetState(events));
  } finally { await rm(lock, { recursive: true }); }
}

export async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--enable') options.enabled = true;
    else if (['--input', '--model', '--budget-rmb'].includes(argv[i]) && argv[i + 1]) options[argv[i].slice(2)] = argv[++i];
    else throw new Error('Usage: teacher-label.mjs --enable --input <local JSON> --model <model> --budget-rmb <1..100>');
  }
  await withTeacher({ ...options, budget: Number(options['budget-rmb']) }, async label => {
    const groups = await json(options.input);
    for (const group of groups) {
      const result = await label(group);
      console.log(JSON.stringify({ groupId: group.id, requestId: result.requestId, cached: !!result.cached }));
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Teacher stopped; inspect local ledger and configuration.'); process.exitCode = 1;
  });
}
