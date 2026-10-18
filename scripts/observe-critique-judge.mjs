#!/usr/bin/env node
// Offline request preparation only. Submit separately through aihub-ray.py.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { cost } from './teacher-label.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CACHE = path.join(ROOT, 'data/cache/w36-vlm-critique');
export const TEACHERS = { flash: 'gemini-3.8-flash', gpt: 'gpt-6-sol', claude: 'claude-opus-5-5' };
const SINGLE_TRANSPORT = 'single-request-v1';
const RATE_LIMIT_POLICY = 'unprocessed-429-v1';
const CONCURRENCY = { flash: 4, gpt: 2, claude: 2 };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const saveJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const saveJsonl = (file, value) => writeFile(file, value.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
const localId = value => hash(JSON.stringify(value));
const CORRECT = ['正确', '错误', '无法判断'];
const REASONABLE = ['合理', '不合理', '无法判断'];
const CONTRADICTION = ['矛盾', '不矛盾', '无法判断'];
const NOVELTY = ['新增', '重复', '无法判断'];
export const POLICIES = {
  id: 'critique-v1-three-family-unanimous', version: 1,
  correctness: { correct: 'all_three_correct', wrong: 'at_least_two_wrong', otherwise: 'disputed_excluded_from_precision' },
  editReasonableness: { reasonable: 'all_three_reasonable', unreasonable: 'at_least_two_unreasonable', otherwise: 'disputed_excluded' },
  contradiction: { yes: 'at_least_two_contradiction', no: 'all_three_no_contradiction', otherwise: 'unknown' },
  addsInformation: { yes: 'all_three_new', no: 'at_least_two_duplicate', otherwise: 'unknown' },
  gates: { statementPrecision: 0.90, statementWilsonLow: 0.85, minStatements: 140,
    editReasonableness: 0.85, editWilsonLow: 0.80, minEdits: 140 },
  teachers: TEACHERS, pilotMaxPhotos: 20, budgetCapCny: 1200,
  referenceCaveat: '老师是参照而非真值，可能偏好自身文风。',
};

export function budgetCap(value = process.env.ECP_AIHUB_BUDGET_RMB) {
  const cap = Number(value);
  if (!(Number.isFinite(cap) && cap > 0 && cap <= 1200)) throw new Error('ECP_AIHUB_BUDGET_RMB must be in (0,1200]');
  return cap;
}

export async function preregister(cache, metadata = {}) {
  await mkdir(cache, { recursive: true });
  const file = path.join(cache, 'preregistration.json');
  const value = { ...POLICIES, metadata };
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await json(file);
    if (JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('preregistration is immutable');
  }
  return { file, sha256: hash(await readFile(file)), value };
}

export async function readPreregistration(cache) {
  const file = path.join(cache, 'preregistration.json'), raw = await readFile(file);
  const value = JSON.parse(raw);
  for (const key of Object.keys(POLICIES)) if (JSON.stringify(value[key]) !== JSON.stringify(POLICIES[key])) {
    throw new Error('preregistered policies do not match the fixed W36 policies');
  }
  return { file, sha256: hash(raw), value };
}

export function selectPilot(rows, manifest, count = 20) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('pilot must use 1..20 photos');
  const available = new Set(rows.map(row => row.item_id ?? row.itemId ?? row.id));
  const ids = manifest.filter(item => item.set === 'photos' && available.has(item.id)).map(item => item.id)
    .sort((a, b) => hash('w36-pilot|' + a).localeCompare(hash('w36-pilot|' + b))).slice(0, count);
  if (!ids.length) throw new Error('pilot has no photo critiques');
  return rows.filter(row => ids.includes(row.item_id ?? row.itemId ?? row.id));
}

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('unsafe image path');
  return value;
}

function statementsFor(row) {
  if (!Array.isArray(row.statements) || row.statements.length < 1 || row.statements.length > 10) {
    throw new Error('missing atomic statements');
  }
  const seen = new Set();
  return row.statements.map(statement => {
    if (!statement || typeof statement.id !== 'string' || !statement.id || seen.has(statement.id)
      || !['strength', 'issue', 'edit', 'verdict'].includes(statement.kind) || typeof statement.text !== 'string'
      || !statement.text || [...statement.text].length > 500) throw new Error('invalid atomic statement');
    seen.add(statement.id);
    return Object.fromEntries(['id', 'kind', 'category', 'text', 'action', 'direction', 'amount', 'reason', 'region']
      .filter(key => statement[key] != null).map(key => [key, statement[key]]));
  });
}

export function judgmentSchema(statements) {
  return { type: 'object', additionalProperties: false, required: ['statements'], properties: {
    statements: { type: 'array', minItems: statements.length, maxItems: statements.length, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'correctness', 'reasonableness', 'contradiction', 'adds_information'], properties: {
        id: { type: 'string', enum: statements.map(statement => statement.id) },
        correctness: { type: 'string', enum: CORRECT }, reasonableness: { type: 'string', enum: REASONABLE },
        contradiction: { type: 'string', enum: CONTRADICTION }, adds_information: { type: 'string', enum: NOVELTY },
      },
    } },
  } };
}

export function judgePrompt(statements, facts) {
  return ['你是照片点评的独立核验者。只根据这一张照片可见的内容核验各条陈述，不猜测。',
    '图像最长边不超过768像素，不能据此确认细微清晰度、噪点或皮肤细节。不要因语气或文风偏好打分。',
    '逐条保持原id，correctness仅选正确/错误/无法判断。正确要求整条内容均可由图支持；主观或不可见则无法判断。',
    '编辑还须判断是否可在Lightroom类工具实施、幅度适当且会改善照片，reasonableness选合理/不合理/无法判断；非编辑填无法判断。',
    '以下专用模型事实均已通过门槛，仅用于独立比较，与你是否喜欢点评风格无关；不透露点评生成时是否使用事实。',
    '已知事实只用于contradiction和adds_information；不能替代correctness和reasonableness所需的图像证据。',
    `已知事实：${JSON.stringify(facts.map(fact => ({ id: fact.id, text: fact.text })))}`,
    'contradiction选矛盾/不矛盾/无法判断，只判断该陈述是否与已知事实冲突；无事实填无法判断。',
    'adds_information选新增/重复/无法判断：陈述是否包含已知事实没有提供的信息；事实为空且陈述清楚则新增。',
    'verdict是供用户参考的保留建议，只有图像充分支持时才判正确；无法仅据单张照片判断必要性时选无法判断。',
    `待核验陈述：${JSON.stringify(statements)}`, '只返回指定JSON，不附解释。'].join('\n');
}

export function validateJudgment(value, statements) {
  if (!value || Object.keys(value).join() !== 'statements' || !Array.isArray(value.statements)
    || value.statements.length !== statements.length) return false;
  const wanted = new Set(statements.map(statement => statement.id)), seen = new Set();
  return value.statements.every(row => {
    if (!row || Object.keys(row).sort().join() !== 'adds_information,contradiction,correctness,id,reasonableness'
      || !wanted.has(row.id) || seen.has(row.id)) return false;
    seen.add(row.id);
    return CORRECT.includes(row.correctness) && REASONABLE.includes(row.reasonableness)
      && CONTRADICTION.includes(row.contradiction) && NOVELTY.includes(row.adds_information);
  });
}

function parsedContent(content) {
  try { return JSON.parse(String(content).replace(/^\s*```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '')); }
  catch { return null; }
}

async function receiptBatches(cache) {
  const batches = [];
  async function walk(dir) {
    const names = await readdir(dir, { withFileTypes: true });
    if (names.some(entry => entry.name === 'judge-batch.json')) {
      const metadata = await json(path.join(dir, 'judge-batch.json'));
      const requests = await jsonl(path.join(dir, 'requests.jsonl'));
      const config = await json(path.join(dir, 'config.json'));
      const results = await jsonl(path.join(dir, 'results.jsonl')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      batches.push({ dir, metadata, requests, config, results });
    }
    for (const entry of names) if (entry.isDirectory()) await walk(path.join(dir, entry.name));
  }
  await walk(cache);
  return batches;
}

function requestReservation(request, config) {
  const body = request.body, price = config.pricing?.[body?.model];
  if (!price || !['input', 'output', 'usdToCny'].every(key => Number.isFinite(price[key]) && price[key] > 0)) {
    throw new Error('receipt missing valid saved pricing');
  }
  const input = config.inputTokenReserve, output = body.max_completion_tokens;
  const bounded = config.strictBudget === true && Number.isSafeInteger(input) && input >= 16000
    && Number.isSafeInteger(output) && output > 0 && output <= 3000;
  const amount = bounded ? cost({ prompt_tokens: input, completion_tokens: output }, price) : null;
  if (amount != null && !Number.isFinite(amount)) throw new Error('non-finite budget reservation');
  return { price, input, output, bounded, amount };
}

function transportLimit(result, config) {
  if (config.strictBudget !== true) return null;
  if (config.transportPolicy === SINGLE_TRANSPORT) {
    if (!result) return 1;
    if (config.rateLimitPolicy === RATE_LIMIT_POLICY) {
      const total = result.httpAttempts, rejected = result.rejected429Attempts, paid = result.paidAttempts;
      if (result.transportPolicy !== SINGLE_TRANSPORT || result.rateLimitPolicy !== RATE_LIMIT_POLICY
        || !Number.isSafeInteger(total) || total < 1 || total > config.rateLimitRetries + 1
        || result.attempts !== total || result.transportAttempts !== total || !Number.isSafeInteger(rejected)
        || rejected < 0 || rejected > total || paid !== total - rejected || ![0, 1].includes(paid)) return null;
      if (paid === 0 && result.usage && ['prompt_tokens', 'completion_tokens'].some(key => result.usage[key] > 0)) return null;
      if (paid === 0 && (result.status !== 429 || result.costStatus !== 'unprocessed_429' || result.reservedCny !== 0)) return null;
      if (paid === 1 && result.status === 429) return null;
      return paid;
    }
    return result.transportPolicy === SINGLE_TRANSPORT && result.transportAttempts === 1 && result.attempts === 1 ? 1 : null;
  }
  if (config.transportPolicy != null
    || result && (result.transportPolicy != null || result.transportAttempts != null || result.attempts !== 1)) return null;
  return 2;
}

function carriedReservation(result, reservation, transports) {
  if (reservation.bounded && transports === 0) return 0;
  if (!reservation.bounded || transports == null || (result.attempts !== 1 && result.rateLimitPolicy !== RATE_LIMIT_POLICY)
    || result.costStatus !== 'reserved_unknown'
    || !Number.isFinite(result.reservedCny) || result.reservedCny < reservation.amount - 1e-9
    || !Number.isInteger(result.status)
    || (![0, 200].includes(result.status) && !(result.status >= 400 && result.status <= 599))) return null;
  return Math.max(result.reservedCny, reservation.amount) * transports;
}

export async function auditBudget(cache, { cap = budgetCap(), plannedCritiques } = {}) {
  budgetCap(cap);
  const batches = await receiptBatches(cache);
  let spentCny = 0, outstandingCny = 0, settledRequests = 0, unresolvedRequests = 0;
  let legacyRouteCny = 0, legacyRouteRequests = 0, pilotLegacyRouteCny = 0, pilotUnknownCny = 0, submittedRequestMaximumCny = 0;
  let carriedUnknownCny = 0, carriedUnknownRequests = 0, pendingCny = 0, pendingRequests = 0, unboundedRequests = 0;
  const pilotPhotos = new Set(), pilotCritiques = new Set(), pilotRequests = new Set(), submittedPlan = new Set();
  let pilotSpentCny = 0, pilotFailures = 0;
  for (const batch of batches) {
    const seen = new Set();
    for (const result of batch.results) {
      if (seen.has(result.id)) throw new Error('duplicate receipt id requires manual audit');
      seen.add(result.id);
      if (!batch.requests.some(request => request.id === result.id)) throw new Error('receipt without prepared request');
    }
    const submitted = await readFile(path.join(batch.dir, 'job.json'), 'utf8').then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (!submitted && batch.results.length) throw new Error('receipts without submission record');
    if (!submitted) continue;
    for (const entry of batch.metadata.entries) {
      const key = [entry.model, entry.variant, entry.item_id];
      if (!key.every(value => typeof value === 'string' && value)) throw new Error('invalid submitted planned critique key');
      submittedPlan.add(JSON.stringify(key));
    }
    for (const request of batch.requests) {
      const result = batch.results.find(result => result.id === request.id);
      const reservation = requestReservation(request, batch.config);
      const transports = transportLimit(result, batch.config);
      if (reservation.bounded && transports != null) submittedRequestMaximumCny += reservation.amount * transports;
      const known = result?.usage && ['prompt_tokens', 'completion_tokens'].every(key =>
        Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0);
      let amount = 0;
      if (known) {
        amount = cost(result.usage, reservation.price);
        if (!Number.isFinite(amount)) throw new Error('non-finite response cost');
        spentCny += amount; settledRequests++;
        if (!reservation.bounded || transports == null || result.usage.prompt_tokens > reservation.input
          || result.usage.completion_tokens > reservation.output) {
          unboundedRequests++;
        }
        if (reservation.bounded && transports === 2) {
          // A legacy success can follow a billed first route whose response was lost.
          outstandingCny += reservation.amount; legacyRouteCny += reservation.amount; legacyRouteRequests++;
          if (batch.metadata.phase === 'pilot') pilotLegacyRouteCny += reservation.amount;
        }
      } else {
        unresolvedRequests++;
        const carried = result ? carriedReservation(result, reservation, transports) : null;
        // Unreturned calls remain blocked until collection; no assumption that
        // an interrupted job stopped before making a request is safe here.
        amount = carried ?? (reservation.amount == null ? 0 : reservation.amount * (transports ?? 2));
        outstandingCny += amount;
        if (!result) {
          pendingRequests++; pendingCny += amount;
          if (!reservation.bounded || transports == null) unboundedRequests++;
        }
        else if (carried != null && batch.metadata.phase === 'full') {
          carriedUnknownRequests++; carriedUnknownCny += amount;
        } else unboundedRequests++;
      }
      if (batch.metadata.phase === 'pilot') {
        if (known) pilotSpentCny += amount;
        else { pilotFailures++; pilotUnknownCny += amount; }
        pilotRequests.add(request.id);
      }
    }
    if (batch.metadata.phase === 'pilot') for (const entry of batch.metadata.entries) {
      pilotPhotos.add(entry.item_id); pilotCritiques.add(entry.critique_id);
    }
  }
  const costPerPhotoCny = pilotPhotos.size ? pilotSpentCny / pilotPhotos.size : null;
  const total = plannedCritiques ?? Math.max(0, ...batches.map(batch => batch.metadata.plannedCritiques ?? 0));
  if (!Number.isSafeInteger(total) || total < pilotCritiques.size || total < submittedPlan.size) {
    throw new Error('invalid planned critique count');
  }
  const pilotUnitCostCny = pilotCritiques.size ? pilotSpentCny / pilotCritiques.size : null;
  const remainingPlannedCritiques = total - submittedPlan.size;
  const projectedRemainingCny = pilotUnitCostCny == null ? null : pilotUnitCostCny * remainingPlannedCritiques;
  const projectedTotalCny = pilotUnitCostCny == null ? null : pilotUnitCostCny * total;
  const pilotMaximumCny = pilotSpentCny + pilotLegacyRouteCny + pilotUnknownCny;
  const projectedPilotMaximumCny = pilotCritiques.size ? pilotMaximumCny / pilotCritiques.size * total : null;
  const committedMaximumCny = unboundedRequests ? null : spentCny + outstandingCny;
  const projectedWithReservationsCny = committedMaximumCny == null || projectedRemainingCny == null ? null
    : committedMaximumCny + projectedRemainingCny;
  return { capCny: cap, spentCny, outstandingCny, settledRequests, unresolvedRequests,
    legacyRouteCny, legacyRouteRequests, carriedUnknownCny, carriedUnknownRequests, pendingCny, pendingRequests, unboundedRequests,
    committedMaximumCny, submittedRequestMaximumCny: unboundedRequests ? null : submittedRequestMaximumCny,
    remainingBudgetCny: committedMaximumCny == null ? 0 : Math.max(0, cap - committedMaximumCny),
    pilot: { photos: pilotPhotos.size, critiques: pilotCritiques.size, requests: pilotRequests.size,
      spentCny: pilotSpentCny, legacyRouteCny: pilotLegacyRouteCny, unknownCny: pilotUnknownCny, maximumCny: pilotMaximumCny,
      unresolvedRequests: pilotFailures, costPerPhotoCny,
      maximumCostPerPhotoCny: pilotPhotos.size ? pilotMaximumCny / pilotPhotos.size : null },
    plannedCritiques: total, submittedPlannedCritiques: submittedPlan.size, remainingPlannedCritiques,
    projectedTotalCny, projectedRemainingCny, projectedPilotMaximumCny, projectedWithReservationsCny,
    mayProceedFull: pilotPhotos.size > 0 && pilotPhotos.size <= 20 && pilotFailures === 0
      && pendingRequests === 0 && unboundedRequests === 0 && projectedWithReservationsCny != null
      && projectedWithReservationsCny <= cap && committedMaximumCny <= cap };
}

async function cacheFile(cache, name) {
  const root = await realpath(cache), file = await realpath(path.join(root, relative(name)));
  if (!file.startsWith(root + path.sep)) throw new Error('resume artifact escapes line cache');
  return file;
}
const exists = file => readFile(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const variantsFor = (plan, id) => plan.variantsBySet[plan.setById.get(id)] ?? [];
const planKey = entry => JSON.stringify([entry.model, entry.variant, entry.item_id, entry.family]);

export async function readResumePlan(cache, file) {
  const root = await realpath(cache), target = await realpath(path.resolve(file));
  if (!target.startsWith(root + path.sep)) throw new Error('resume plan must stay in line cache');
  const raw = await readFile(target), value = JSON.parse(raw), digest = hash(raw);
  const full = value.schemaVersion === 2;
  if (![1, 2].includes(value.schemaVersion) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id || '')
    || !Number.isFinite(Date.parse(value.createdAt)) || value.promptVersion !== '1.0.1'
    || !(value.budget?.incrementalCny > 0 && value.budget.incrementalCny <= (full ? 900 : 400))
    || !(value.budget?.totalCny > 0 && value.budget.totalCny <= 2000)
    || value.cohort?.count !== (full ? 491 : 200) || value.cohort?.set !== (full ? 'manifest' : 'photos')
    || !Array.isArray(value.models) || JSON.stringify(value.models) !== JSON.stringify([
      'openbmb/MiniCPM-V-4.7-35B-A3B-int4', 'Qwen/Qwen3.6-35B-A3B'])) throw new Error('invalid immutable resume plan');
  if (full && (value.authorization?.type !== 'full-900' || value.authorization?.allowConservativeBoundExceedance !== true
    || typeof value.authorization?.reason !== 'string' || !value.authorization.reason.trim()
    || !sameJson(value.cohort.bySet, { photos: 291, openimages: 200 })
    || !sameJson(value.cohort.variants, { photos: ['A', 'B'], openimages: ['A'] })
    || !sameJson(value.concurrency, { flash: 8, gpt: 4, claude: 4 }))) throw new Error('invalid full-900 authorization or cohort policy');
  const preregistration = await readPreregistration(cache);
  const prompt = await readFile(path.join(ROOT, 'ml/observe/prompts/critique-v1.md'));
  if (preregistration.sha256 !== value.preregistrationSha256 || hash(prompt) !== value.promptSha256
    || !/"version"\s*:\s*"1\.0\.1"/.test(prompt.toString())) throw new Error('resume prompt or preregistration checksum mismatch');
  async function artifact(record) {
    const input = await cacheFile(cache, record?.file), data = await readFile(input);
    if (hash(data) !== record.sha256) throw new Error('resume artifact checksum mismatch');
    return data;
  }
  const cohort = JSON.parse(await artifact(value.cohort));
  if (!Array.isArray(cohort) || cohort.length !== value.cohort.count || new Set(cohort).size !== value.cohort.count
    || !cohort.every(id => typeof id === 'string' && /^[\w-]+$/.test(id))) {
    throw new Error('resume cohort must contain the fixed distinct image IDs');
  }
  const manifest = (await artifact(value.manifest)).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const setById = new Map(manifest.map(item => [item.id, item.set]));
  if (!cohort.every(id => setById.get(id) === 'photos' || full && setById.get(id) === 'openimages')) {
    throw new Error('resume cohort is outside frozen photo manifest');
  }
  if (full && (manifest.length !== 491 || new Set(manifest.map(item => item.id)).size !== 491
    || cohort.filter(id => setById.get(id) === 'photos').length !== 291
    || cohort.filter(id => setById.get(id) === 'openimages').length !== 200)) {
    throw new Error('full-900 requires the whole 291-photo and 200-Open-Images manifest');
  }
  const variantsBySet = full ? value.cohort.variants : { photos: ['A', 'B'] };
  const pricing = JSON.parse(await artifact(value.pricing));
  for (const model of Object.values(TEACHERS)) if (!pricing[model] || !['input', 'output', 'usdToCny'].every(key =>
    Number.isFinite(pricing[model][key]) && pricing[model][key] > 0)) throw new Error('invalid resume teacher pricing');
  const legacy = new Set(), samples = Object.fromEntries(Object.values(TEACHERS).map(model => [model, []]));
  let legacyMaximumCny = 0, legacySpentCny = 0;
  if (!Array.isArray(value.legacyBatches) || !value.legacyBatches.length) {
    throw new Error('resume plan requires an exact legacy paid boundary');
  }
  for (const batch of value.legacyBatches) {
    const dir = await cacheFile(cache, batch.dir);
    if (legacy.has(dir)) throw new Error('duplicate resume legacy batch');
    legacy.add(dir);
    for (const [name, key] of [['requests.jsonl', 'requestsSha256'], ['config.json', 'configSha256'], ['job.json', 'jobSha256'],
      ['results.jsonl', 'resultsSha256']]) {
      if (hash(await readFile(path.join(dir, name))) !== batch[key]) throw new Error('resume legacy boundary checksum mismatch');
    }
    const config = await json(path.join(dir, 'config.json')), requests = await jsonl(path.join(dir, 'requests.jsonl'));
    const legacyMetadata = await json(path.join(dir, 'judge-batch.json'));
    if (legacyMetadata.resumeCampaign) throw new Error('resume allowance cannot be reset through a later legacy boundary');
    for (const request of requests) {
      const bound = requestReservation(request, config), transports = transportLimit(null, config);
      if (!bound.bounded || transports == null) throw new Error('unbounded legacy request at resume boundary');
      legacyMaximumCny += bound.amount * transports;
    }
    for (const result of await jsonl(path.join(dir, 'results.jsonl'))) {
      const request = requests.find(request => request.id === result.id);
      if (!request) throw new Error('legacy receipt outside frozen requests');
      if (result.usage && ['prompt_tokens', 'completion_tokens'].every(key =>
        Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0)) {
        const bound = requestReservation(request, config);
        if (result.usage.prompt_tokens > bound.input || result.usage.completion_tokens > bound.output) {
          throw new Error('observed legacy usage exceeds frozen maximum');
        }
        legacySpentCny += cost(result.usage, config.pricing[request.body.model]);
        if (legacyMetadata.phase === 'pilot') samples[request.body.model]?.push(result.usage);
      }
    }
  }
  if (!full && legacyMaximumCny + value.budget.incrementalCny > value.budget.totalCny + 1e-8) {
    throw new Error('legacy maximum plus resume allowance exceeds total authorization');
  }
  return { file: target, relative: path.relative(root, target), sha256: digest, value, cohort, manifest, pricing,
    legacy, legacyMaximumCny, legacySpentCny, samples, full, setById, variantsBySet };
}

export async function freezeResumePlan(cache, input, output) {
  const plan = await readResumePlan(cache, input), root = await realpath(cache);
  const file = path.join(root, relative(path.relative(path.resolve(cache), path.resolve(output))));
  if (path.dirname(file) !== root) throw new Error('freeze resume plan directly in the line cache');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(await readFile(plan.file)); await handle.sync(); }
  finally { await handle.close(); }
  return { file, sha256: plan.sha256, id: plan.value.id };
}

export async function auditResumeBudget(cache, file, { authorizationCny = Number(process.env.ECP_AIHUB_BUDGET_RMB) } = {}) {
  const plan = await readResumePlan(cache, file);
  if (!(Number.isFinite(authorizationCny) && authorizationCny >= plan.value.budget.totalCny && authorizationCny <= 2000)) {
    throw new Error('resume requires explicit ECP_AIHUB_BUDGET_RMB total authorization');
  }
  let spentCny = 0, outstandingCny = 0, knownRequests = 0, unresolvedRequests = 0, pendingRequests = 0, unboundedRequests = 0,
    unprocessed429Requests = 0, latestModel = -1;
  const purchased = new Set(), ids = new Set(), submitted = [];
  for (const batch of await receiptBatches(cache)) {
    if (!(await exists(path.join(batch.dir, 'job.json')))) continue;
    const dir = await realpath(batch.dir);
    if (plan.legacy.has(dir)) continue;
    if (batch.metadata.resumePlanSha256 !== plan.sha256 || batch.metadata.resumeCampaign !== plan.value.id
      || batch.config.transportPolicy !== SINGLE_TRANSPORT || !sameJson(batch.config.pricing, plan.pricing)) {
      throw new Error('submitted paid batch outside immutable resume campaign');
    }
    await checkResumeBatch(plan, batch);
    const receipts = new Map();
    for (const result of batch.results) {
      if (receipts.has(result.id)) throw new Error('duplicate resume receipt');
      receipts.set(result.id, result);
      if (!batch.requests.some(request => request.id === result.id)) throw new Error('unknown resume receipt');
    }
    for (const entry of batch.metadata.entries) {
      if (!plan.cohort.includes(entry.item_id) || !variantsFor(plan, entry.item_id).includes(entry.variant) || entry.ask !== 0
        || entry.prompt_sha256 !== plan.value.promptSha256 || !plan.value.models.includes(entry.model) || !TEACHERS[entry.family]) {
        throw new Error('resume request outside frozen cohort or prompt');
      }
      const key = planKey(entry);
      if (purchased.has(key)) throw new Error('resume planned statement family was purchased twice');
      purchased.add(key); latestModel = Math.max(latestModel, plan.value.models.indexOf(entry.model));
    }
    for (const request of batch.requests) {
      if (ids.has(request.id)) throw new Error('resume request purchased twice');
      ids.add(request.id);
      if (batch.metadata.entries.filter(entry => entry.request_id === request.id).length !== 1) {
        throw new Error('resume request metadata mismatch');
      }
      const result = receipts.get(request.id), reservation = requestReservation(request, batch.config),
        transports = transportLimit(result, batch.config);
      const known = result?.usage && ['prompt_tokens', 'completion_tokens'].every(key =>
        Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0);
      if (!reservation.bounded || ![0, 1].includes(transports)) unboundedRequests++;
      if (transports === 0) { unprocessed429Requests++; }
      else if (known) {
        spentCny += cost(result.usage, reservation.price); knownRequests++;
        if (result.usage.prompt_tokens > reservation.input || result.usage.completion_tokens > reservation.output) {
          unboundedRequests++;
        }
      } else {
        unresolvedRequests++;
        if (!result) { pendingRequests++; outstandingCny += reservation.amount ?? 0; }
        else {
          const amount = carriedReservation(result, reservation, transports);
          if (amount == null) unboundedRequests++;
          outstandingCny += amount ?? reservation.amount ?? 0;
        }
      }
    }
    submitted.push(path.relative(await realpath(cache), dir));
  }
  const committedMaximumCny = unboundedRequests ? null : spentCny + outstandingCny;
  const remainingBudgetCny = committedMaximumCny == null ? 0
    : Math.max(0, plan.value.budget.incrementalCny - committedMaximumCny);
  const plannedCritiques = plan.cohort.reduce((sum, id) => sum + variantsFor(plan, id).length, 0) * plan.value.models.length;
  const submittedCritiques = new Set([...purchased].map(key => JSON.stringify(JSON.parse(key).slice(0, 3)))).size;
  const estimatedPerCritiqueCny = Object.values(TEACHERS).reduce((sum, model) =>
    sum + estimateResumeRequest({ body: { model } }, plan), 0);
  const forecastCny = committedMaximumCny == null ? null
    : committedMaximumCny + Math.max(0, plannedCritiques - submittedCritiques) * estimatedPerCritiqueCny;
  return { campaign: plan.value.id, resumePlanSha256: plan.sha256, capCny: plan.value.budget.incrementalCny,
    totalCapCny: plan.value.budget.totalCny, legacySpentCny: plan.legacySpentCny, legacyMaximumCny: plan.legacyMaximumCny,
    spentCny, outstandingCny, knownRequests, unresolvedRequests, pendingRequests, unboundedRequests, unprocessed429Requests,
    committedMaximumCny,
    remainingBudgetCny, totalMaximumCny: committedMaximumCny == null ? null : plan.legacyMaximumCny + committedMaximumCny,
    plannedCritiques, submittedCritiques, estimatedPerCritiqueCny, initialForecastCny: plannedCritiques * estimatedPerCritiqueCny,
    forecastCny, forecastHeadroom: 1.25,
    conservativeTotalAllowanceCny: plan.legacyMaximumCny + plan.value.budget.incrementalCny,
    conservativeAllowanceExceedsTotal: plan.legacyMaximumCny + plan.value.budget.incrementalCny > plan.value.budget.totalCny,
    latestModel, submittedBatches: submitted, purchasedKeys: [...purchased],
    maySubmit: unboundedRequests === 0 && committedMaximumCny < plan.value.budget.incrementalCny };
}

async function checkResumeBatch(plan, batch) {
  if (batch.metadata.resumePlanSha256 !== plan.sha256 || batch.metadata.resumeCampaign !== plan.value.id
    || batch.config.transportPolicy !== SINGLE_TRANSPORT || !sameJson(batch.config.pricing, plan.pricing)
    || hash(await readFile(path.join(batch.dir, 'requests.jsonl'))) !== batch.metadata.requestsSha256
    || hash(await readFile(path.join(batch.dir, 'config.json'))) !== batch.metadata.configSha256) {
    throw new Error('resume batch checksum or policy mismatch');
  }
  if (!batch.requests.length || batch.requests.length !== batch.metadata.entries.length) {
    throw new Error('resume request entries are not a bijection');
  }
  if (plan.full && (!sameJson(batch.config.concurrency,
    Object.fromEntries(Object.entries(TEACHERS).map(([family, model]) => [model, plan.value.concurrency[family]])))
    || batch.config.rateLimitPolicy !== RATE_LIMIT_POLICY || batch.config.rateLimitRetries !== 4
    || batch.config.rateLimitBackoffSeconds !== 2 || batch.config.rateLimitBackoffMaxSeconds !== 30)) {
    throw new Error('full-900 transport or concurrency policy differs');
  }
  const ids = new Set(), keys = new Set(), sets = new Set();
  for (const entry of batch.metadata.entries) {
    const request = batch.requests.find(request => request.id === entry.request_id), key = planKey(entry);
    if (!request || ids.has(request.id) || keys.has(key) || !plan.cohort.includes(entry.item_id)
      || !variantsFor(plan, entry.item_id).includes(entry.variant) || entry.ask !== 0 || entry.prompt_sha256 !== plan.value.promptSha256
      || !plan.value.models.includes(entry.model) || TEACHERS[entry.family] !== request.body.model) {
      throw new Error('resume request outside fixed cohort or already present');
    }
    ids.add(request.id); keys.add(key); sets.add(plan.setById.get(entry.item_id));
  }
  if (sets.size !== 1 || plan.full && !sets.has(batch.metadata.set)) throw new Error('resume batch must contain only its declared dataset');
}

export async function validateResumeBatch(cache, file, batchDir, options = {}) {
  const plan = await readResumePlan(cache, file), audit = await auditResumeBudget(cache, file, options);
  const dir = await realpath(batchDir), root = await realpath(cache);
  if (!dir.startsWith(root + path.sep) || await exists(path.join(dir, 'job.json'))) {
    throw new Error('resume batch was submitted or escapes line cache');
  }
  const batch = { dir, metadata: await json(path.join(dir, 'judge-batch.json')), config: await json(path.join(dir, 'config.json')),
    requests: await jsonl(path.join(dir, 'requests.jsonl')) };
  await checkResumeBatch(plan, batch);
  const models = [...new Set(batch.metadata.entries.map(entry => entry.model))], index = plan.value.models.indexOf(models[0]);
  if (models.length !== 1 || index < audit.latestModel || index > audit.latestModel + 1) {
    throw new Error('resume model submission order changed');
  }
  const paid = new Set(audit.purchasedKeys);
  if (batch.metadata.entries.some(entry => paid.has(planKey(entry)))) throw new Error('resume request family was purchased before');
  let maximumCny = 0, estimatedCostCny = 0;
  for (const request of batch.requests) {
    const reservation = requestReservation(request, batch.config);
    if (!reservation.bounded) throw new Error('resume candidate has unbounded request');
    maximumCny += reservation.amount; estimatedCostCny += estimateResumeRequest(request, plan);
  }
  if (!audit.maySubmit || !(batch.config.budgetCny > 0 && batch.config.budgetCny <= audit.remainingBudgetCny + 1e-9)
    || maximumCny > batch.config.budgetCny + 1e-9 || maximumCny > audit.remainingBudgetCny + 1e-9
    || estimatedCostCny > audit.remainingBudgetCny + 1e-9) throw new Error('resume batch exceeds incremental authorization');
  return { ...audit, candidateRequests: batch.requests.length, candidateMaximumCny: maximumCny, candidateEstimatedCny: estimatedCostCny };
}

function estimateResumeRequest(request, plan) {
  const samples = plan.samples[request.body.model] || [];
  if (!samples.length) return cost({ prompt_tokens: 16000, completion_tokens: 3000 }, plan.pricing[request.body.model]);
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens'].map(key =>
    [key, Math.ceil(samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length * 1.25)]));
  return cost(usage, plan.pricing[request.body.model]);
}

async function imageFor(item, prepared, output, cacheImages) {
  const full = relative(item.images?.full);
  if (!/\.jpg$/i.test(full)) throw new Error('judge full view must be JPEG');
  if (item.storage === 'ceph') return { image_file: full, imageRoot: relative(item.imageRoot) };
  const source = await realpath(path.join(prepared, full)), root = await realpath(prepared);
  if (!source.startsWith(root + path.sep)) throw new Error('image escapes prepared corpus');
  if (!cacheImages.has(source)) {
    const data = await readFile(source), metadata = await sharp(data).metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 768
      || metadata.hasProfile || metadata.hasAlpha || metadata.exif || metadata.icc || metadata.xmp || metadata.iptc) {
      throw new Error('judge image must be the stripped <=768px full derivative');
    }
    const destination = 'images/' + hash(data) + '.jpg';
    await mkdir(path.join(output, 'images'), { recursive: true });
    await copyFile(source, path.join(output, destination));
    cacheImages.set(source, destination);
  }
  return { image_file: cacheImages.get(source) };
}

export async function prepareRequests({ cache = DEFAULT_CACHE, rows, manifest, prepared, output, phase = 'pilot',
  pilotPhotos = 20, plannedCritiques, ledgerFile = path.join(ROOT, 'data/cache/teacher/ledger.jsonl'), cap,
  resumePlan, resumePhotos, resumeSet = 'photos', authorizationCny }) {
  const campaign = resumePlan ? await readResumePlan(cache, resumePlan) : null;
  cap = campaign ? campaign.value.budget.incrementalCny : budgetCap(cap);
  const campaignAudit = campaign ? await auditResumeBudget(cache, resumePlan, { authorizationCny }) : null;
  if (campaign && !campaignAudit.maySubmit) throw new Error('incremental campaign budget unavailable');
  const preregistration = await readPreregistration(cache);
  let primary = rows.filter(row => row.ask === 0 || row.ask === '0');
  const campaignIds = campaign ? campaign.cohort.filter(id => campaign.setById.get(id) === resumeSet) : [];
  if (campaign) {
    if (!campaignIds.length) throw new Error('resume dataset is outside frozen cohort');
    resumePhotos ??= campaignIds.length;
    primary = primary.filter(row => campaignIds.includes(row.item_id ?? row.itemId ?? row.id)
      && variantsFor(campaign, row.item_id ?? row.itemId ?? row.id).includes(row.variant));
    const models = [...new Set(primary.map(row => row.model))], model = models[0];
    if (models.length !== 1 || !campaign.value.models.includes(model)) throw new Error('resume batch requires one frozen local model');
    const index = campaign.value.models.indexOf(model);
    if (index < campaignAudit.latestModel || index > campaignAudit.latestModel + 1) {
      throw new Error('resume models must run MiniCPM before Qwen in order');
    }
    if (!Number.isSafeInteger(resumePhotos) || resumePhotos < 1 || resumePhotos > campaignIds.length) {
      throw new Error('resume image batch is outside the fixed dataset size');
    }
    if (primary.some(row => row.prompt_sha256 !== campaign.value.promptSha256 || !['A', 'B'].includes(row.variant))) {
      throw new Error('resume row prompt or variant mismatch');
    }
    for (const id of campaignIds) for (const variant of variantsFor(campaign, id)) {
      if (primary.filter(row => (row.item_id ?? row.itemId ?? row.id) === id && row.variant === variant).length !== 1) {
        throw new Error('resume input must retain both variants of the full frozen cohort');
      }
    }
    if (JSON.stringify(manifest) !== JSON.stringify(campaign.manifest)) throw new Error('resume manifest differs from frozen corpus');
  }
  rows = primary.filter(row => row.critique && !row.error && !row.parse_error);
  if (!rows.length) throw new Error('no valid primary ask0 critiques');
  const total = campaign ? campaign.cohort.reduce((sum, id) => sum + variantsFor(campaign, id).length, 0) * campaign.value.models.length
    : plannedCritiques ?? primary.length;
  if (!Number.isSafeInteger(total) || total < primary.length) throw new Error('planned critique count must cover all input rows');
  const current = campaignAudit ?? await auditBudget(cache, { cap, plannedCritiques: total });
  if (campaign) phase = 'resume';
  if (!['pilot', 'full', ...(campaign ? ['resume'] : [])].includes(phase)) throw new Error('unknown judge phase');
  if (phase === 'pilot' && current.pilot.photos) throw new Error('pilot was already submitted; audit instead of expanding it');
  if (phase === 'full' && !current.mayProceedFull) {
    throw new Error('pilot cost or unresolved budget bounds prohibit full judging');
  }
  let selected = phase === 'pilot' ? selectPilot(rows, manifest, pilotPhotos) : rows;
  if (campaign) {
    const paid = new Set(current.purchasedKeys);
    const photos = campaignIds.filter(id => rows.some(row => (row.item_id ?? row.itemId ?? row.id) === id
      && Object.keys(TEACHERS).some(family => !paid.has(planKey({ model: row.model, variant: row.variant, item_id: id, family })))))
      .slice(0, resumePhotos);
    selected = photos.flatMap(id => rows.filter(row => (row.item_id ?? row.itemId ?? row.id) === id));
    if (!selected.length) throw new Error('no unpurchased valid resume critiques');
  }
  const requested = path.resolve(output), base = path.resolve(cache), allowed = await realpath(cache);
  if (!requested.startsWith(base + path.sep) && !requested.startsWith(allowed + path.sep)) {
    throw new Error('judge output must stay in the W36 cache');
  }
  const out = requested.startsWith(allowed + path.sep) ? requested : path.join(allowed, path.relative(base, requested));
  const ancestors = await realpath(path.dirname(out));
  if (ancestors !== allowed && !ancestors.startsWith(allowed + path.sep)) throw new Error('judge output escapes cache');
  await mkdir(out).catch(error => {
    if (error.code === 'EEXIST') throw new Error('judge batch is immutable; choose a new output directory');
    throw error;
  });
  if (!(await realpath(out)).startsWith(allowed + path.sep)) throw new Error('judge output escapes cache');
  if (await readFile(path.join(out, 'requests.jsonl')).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  })) {
    throw new Error('judge batch is immutable; choose a new output directory');
  }
  const ledger = campaign ? [] : await jsonl(ledgerFile);
  const pricing = campaign?.pricing ?? Object.fromEntries(Object.values(TEACHERS).map(model =>
    [model, ledger.find(row => row.model === model && row.pricing)?.pricing]));
  for (const price of Object.values(pricing)) if (!price || !['input', 'output', 'usdToCny'].every(key =>
    Number.isFinite(price[key]) && price[key] > 0)) throw new Error('missing valid saved teacher pricing');
  const byId = new Map(manifest.map(item => [item.id, item])), requests = [], entries = [], imageCache = new Map(),
    roots = new Set();
  const prior = await receiptBatches(cache), alreadySubmitted = new Set();
  for (const batch of prior) if (await readFile(path.join(batch.dir, 'job.json')).then(() => true, () => false)) {
    for (const request of batch.requests) alreadySubmitted.add(request.id);
  }
  const critiqueIds = new Set();
  for (const row of selected) {
    const itemId = row.item_id ?? row.itemId ?? row.id, item = byId.get(itemId);
    if (!item) throw new Error('critique has no corpus image');
    const statements = statementsFor(row), facts = item.specialist_facts ?? row.specialist_facts ?? [];
    const image = await imageFor(item, prepared, out, imageCache);
    roots.add(image.imageRoot ?? null);
    const critiqueId = localId([row.model, row.variant, row.ask, itemId, row.prompt_sha256 ?? row.promptSha256, row.critique,
      statements]);
    if (critiqueIds.has(critiqueId)) throw new Error('duplicate critique row');
    critiqueIds.add(critiqueId);
    const text = judgePrompt(statements, facts), schema = judgmentSchema(statements);
    if (Buffer.byteLength(text, 'utf8') > 12000) throw new Error('judge request exceeds bounded token reservation');
    for (const [family, model] of Object.entries(TEACHERS)) {
      const id = localId([critiqueId, family, text, schema, preregistration.sha256, image]);
      if (alreadySubmitted.has(id) || campaign
        && current.purchasedKeys.includes(planKey({ model: row.model, variant: row.variant, item_id: itemId, family }))) continue;
      const prompt = model.includes('claude') ? text + '\nJSON结构：' + JSON.stringify(schema) : text;
      requests.push({ id, body: { model, max_completion_tokens: 3000,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt },
          { type: 'image_url', image_file: image.image_file }] }],
        ...(model.includes('claude') ? {}
          : { response_format: { type: 'json_schema', json_schema: { name: 'critique_judge', schema } } }),
      } });
      entries.push({ request_id: id, critique_id: critiqueId, item_id: itemId, family, model: row.model, variant: row.variant,
        ask: row.ask, prompt_sha256: row.prompt_sha256 ?? row.promptSha256, statements });
    }
  }
  if (roots.size !== 1) throw new Error('package and Ceph images need separate judge batches');
  const remaining = cap - current.spentCny - current.outstandingCny;
  if (campaign) {
    const keep = new Set(), groups = new Map(), requestById = new Map(requests.map(request => [request.id, request]));
    let reserved = 0;
    for (const entry of entries) {
      const group = groups.get(entry.item_id) ?? []; group.push(requestById.get(entry.request_id)); groups.set(entry.item_id, group);
    }
    for (const id of campaignIds) {
      const group = groups.get(id) ?? [];
      const amount = group.reduce((sum, request) =>
        sum + cost({ prompt_tokens: 16000, completion_tokens: 3000 }, pricing[request.body.model]), 0);
      if (reserved + amount > remaining + 1e-9) break;
      reserved += amount; for (const request of group) keep.add(request.id);
    }
    requests.splice(0, requests.length, ...requests.filter(request => keep.has(request.id)));
    entries.splice(0, entries.length, ...entries.filter(entry => keep.has(entry.request_id)));
    if (!requests.length) throw new Error('remaining campaign allowance cannot reserve one complete photo');
  }
  const expectedMaximum = requests.reduce((sum, row) =>
    sum + cost({ prompt_tokens: 16000, completion_tokens: 3000 }, pricing[row.body.model]), 0);
  const estimatedCostCny = campaign ? requests.reduce((sum, request) => sum + estimateResumeRequest(request, campaign), 0) : null;
  if (!(remaining > 0)) throw new Error('line budget exhausted');
  const config = { budgetCny: remaining, pricing, concurrency: Object.fromEntries(Object.entries(TEACHERS).map(([family, model]) =>
    [model, campaign?.full ? campaign.value.concurrency[family] : CONCURRENCY[family]])),
    ...(campaign?.full ? { rateLimitPolicy: RATE_LIMIT_POLICY, rateLimitRetries: 4, rateLimitBackoffSeconds: 2,
      rateLimitBackoffMaxSeconds: 30 } : {}),
    pauseSeconds: 1, timeoutSeconds: phase === 'pilot' ? 1800 : 4 * 3600, inputTokenReserve: 16000, strictBudget: true,
    transportPolicy: SINGLE_TRANSPORT,
    ...(roots.has(null) ? {} : { imageRoot: [...roots][0] }) };
  const metadata = { ...(campaign ? { resumePlanFile: campaign.relative, resumePlanSha256: campaign.sha256,
    resumeCampaign: campaign.value.id, set: resumeSet, estimatedCostCny, estimateHeadroom: 1.25 } : {}),
    phase, preregistrationSha256: preregistration.sha256, plannedCritiques: total,
    primaryInputRows: primary.length, excludedInvalidRows: primary.length - rows.length,
    selectedPhotos: [...new Set(entries.map(row => row.item_id))], entries,
    requestCount: requests.length, reservedMaximumCny: expectedMaximum, budgetCny: remaining };
  if (phase === 'pilot' && metadata.selectedPhotos.length > 20) throw new Error('pilot exceeds 20 photos');
  await saveJsonl(path.join(out, 'requests.jsonl'), requests);
  await saveJson(path.join(out, 'config.json'), config);
  if (campaign) {
    metadata.requestsSha256 = hash(await readFile(path.join(out, 'requests.jsonl')));
    metadata.configSha256 = hash(await readFile(path.join(out, 'config.json')));
  }
  await saveJson(path.join(out, 'judge-batch.json'), metadata);
  return { phase, photos: metadata.selectedPhotos.length, critiques: new Set(entries.map(entry => entry.critique_id)).size,
    requests: requests.length,
    excludedInvalidRows: metadata.excludedInvalidRows,
    reservedMaximumCny: expectedMaximum, budgetCny: remaining,
    ...(campaign ? { estimatedCostCny, resumePlanSha256: campaign.sha256 } : {}) };
}

export async function collectJudgments(batch) {
  const metadata = await json(path.join(batch, 'judge-batch.json'));
  const results = await jsonl(path.join(batch, 'results.jsonl'));
  const entries = new Map(metadata.entries.map(entry => [entry.request_id, entry]));
  const seen = new Set(), judgments = [];
  for (const row of results) {
    if (seen.has(row.id)) throw new Error('duplicate judge receipt');
    seen.add(row.id);
    const entry = entries.get(row.id);
    if (!entry) throw new Error('unknown judge receipt');
    const value = row.status === 200 ? parsedContent(row.content) : null;
    const valid = validateJudgment(value, entry.statements);
    judgments.push({ critique_id: entry.critique_id, item_id: entry.item_id, model: entry.model, variant: entry.variant,
      ask: entry.ask, prompt_sha256: entry.prompt_sha256, teacher: entry.family, status: row.status,
      valid, statements: valid ? value.statements.map(statement => ({ ...statement, novelty: statement.adds_information })) : [] });
  }
  await saveJsonl(path.join(batch, 'judgments.jsonl'), judgments);
  return { judgments, valid: judgments.filter(row => row.valid).length, total: metadata.entries.length };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export async function blindedSheet({ rows, manifest, prepared, output, keyFile, count = 30 }) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 30) throw new Error('blind sample must contain 1..30 photos');
  const photos = manifest.filter(item => item.set === 'photos')
    .sort((a, b) => hash('w36-blind|' + a.id).localeCompare(hash('w36-blind|' + b.id)));
  const selected = [], key = [];
  for (const item of photos) {
    const candidates = rows.filter(row => (row.item_id ?? row.itemId ?? row.id) === item.id && row.critique && row.ask === 0)
      .sort((a, b) => localId([item.id, a.model, a.variant, a.ask]).localeCompare(localId([item.id, b.model, b.variant, b.ask])));
    if (!candidates.length) continue;
    const row = candidates[0], id = '样本' + String(selected.length + 1).padStart(2, '0');
    if (item.storage === 'ceph') throw new Error('blind photo sheet requires local p0 derivatives');
    const data = await readFile(path.join(prepared, relative(item.images.full)));
    const metadata = await sharp(data).metadata();
    if (metadata.format !== 'jpeg' || Math.max(metadata.width || 0, metadata.height || 0) > 768 || metadata.exif || metadata.xmp
      || metadata.icc) {
      throw new Error('blind image is not a stripped p0 derivative');
    }
    selected.push(`<article><h2>${id}</h2><img src="data:image/jpeg;base64,${data.toString('base64')}" alt="${id}">`
      + `<pre>${escapeHtml(JSON.stringify(row.critique, null, 2))}</pre><p>人工意见：□ 可用　□ 不可用　□ 待讨论</p></article>`);
    key.push({ id, item_id: item.id, model: row.model, variant: row.variant, ask: row.ask });
    if (selected.length >= count) break;
  }
  await writeFile(output, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>照片点评盲审</title>'
    + '<style>body{font:16px sans-serif;max-width:1000px;margin:2em auto}'
    + 'article{break-after:page;border-bottom:1px solid #aaa;padding:1em}'
    + 'img{max-width:100%;max-height:70vh}pre{white-space:pre-wrap}</style>'
    + '<h1>照片点评盲审</h1><p>模型与提示变体已隐藏。老师仅为参照，请独立判断。</p>' + selected.join('') + '</html>', { mode: 0o600 });
  await saveJson(keyFile, key);
  return { photos: selected.length };
}

export async function main(argv) {
  const action = argv.shift(), options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) throw new Error('expected --option value');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const cache = path.resolve(options.cache ?? DEFAULT_CACHE);
  if (action === 'freeze-resume') return freezeResumePlan(cache, options.input, options.output);
  if (action === 'audit-resume') {
    const result = options.batch ? await validateResumeBatch(cache, options['resume-plan'], options.batch)
      : await auditResumeBudget(cache, options['resume-plan']);
    const { purchasedKeys, ...summary } = result; return { ...summary, purchasedRequests: purchasedKeys.length };
  }
  if (action === 'preregister') {
    const metadata = options.metadata ? await json(options.metadata) : {};
    const out = await preregister(cache, metadata); return { preregistrationSha256: out.sha256 };
  }
  if (action === 'audit') {
    return auditBudget(cache, { cap: budgetCap(), plannedCritiques: options.total ? Number(options.total) : undefined });
  }
  if (action === 'collect') {
    const out = await collectJudgments(options.batch); return { valid: out.valid, total: out.total };
  }
  if (!['prepare', 'blind'].includes(action)) throw new Error('use preregister, prepare, audit, collect, or blind');
  let rows = (await Promise.all(String(options.rows).split(',').map(jsonl))).flat();
  const manifest = await jsonl(options.manifest), prepared = options.prepared ?? path.dirname(options.manifest);
  if (options.set) {
    if (!['photos', 'openimages'].includes(options.set)) throw new Error('set must be photos or openimages');
    const wanted = new Set(manifest.filter(item => item.set === options.set).map(item => item.id));
    rows = rows.filter(row => wanted.has(row.item_id ?? row.itemId ?? row.id));
  }
  if (action === 'blind') return blindedSheet({ rows, manifest, prepared, output: options.output,
    keyFile: options.key ?? path.join(cache, 'blind-key.json') });
  return prepareRequests({ rows, manifest, prepared, cache, output: options.output, phase: options.phase ?? 'pilot',
    pilotPhotos: options.photos ? Number(options.photos) : 20, plannedCritiques: options.total ? Number(options.total) : undefined,
    ledgerFile: options.ledger,
    resumePlan: options['resume-plan'], resumePhotos: options.photos ? Number(options.photos) : undefined,
    resumeSet: options.set ?? 'photos' });
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value)), error => {
    console.error('Critique judging stopped: ' + error.message); process.exitCode = 1;
  });
}
