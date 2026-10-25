import { resultAiTags } from './item-analysis.js';
import { streamReport } from "./stream-report.js";
import { pageOptions } from "./pagination.js";
import { handleLearningRoute, learningServices } from "./learning-routes.js";
import { handleFeedbackRoute } from "./feedback-routes.js";
import { DecisionsStore } from "../core/decisions-store.js";
import { DECISION_ACTIONS } from "../core/contracts.js";
import {
  planWriteback, applyWriteback, withLiveTags, planRevertWriteback,
  validateRevertRecords, writebackRecords, revertedRecords, mergeWritebackRecords, addLiveStars, summarizeWriteback
} from "../core/writeback.js";
import { handleGroupRoute } from "./group-routes.js";
import { buildReport, reportCsv } from "../core/report.js";
import { personalizeReport } from "../core/personalize.js";
import { appliedPersonalization, applyWithUndo, readPersonalizeUndo, undoPersonalization } from './personalize-undo.js';
import { CORS_HEADERS } from "./http.js";
import { handleAdjustmentsRoute } from "./adjustments-routes.js";
import { buildQueue, filterQueue, MODES } from './queue.js';
import { ACTION_STARS, STAR_HEADER } from '../plugin/star-sync.js';

export const wantsStars = req => req.headers?.[STAR_HEADER] === '1';

export async function handleReviewRoute(req, res, ctx) {
  if (await handleAdjustmentsRoute(req, res, ctx)) return true;
  if (await handleFeedbackRoute(req, res, ctx)) return true;
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return false;
  const [, runId, action] = match;
  // Mutations reload the current full state inside their run queue. Training
  // and status only need the run identity; neither should parse all embeddings.
  const metadataOnly = req.method === "POST" && action === "decisions" ||
    req.method === "POST" && url.pathname === `/runs/${runId}/writeback/live` ||
    req.method === 'GET' && action === 'review-progress' ||
    action === "learning" && (req.method === "GET" || /\/learning\/(train|rollback)$/.test(url.pathname));
  if (req.method === 'GET' && action === 'report' && ctx.runStore.page) {
    return streamReport(req, res, ctx.runStore, runId, url, ctx.json);
  }
  if (req.method === 'GET' && action === 'decisions' && ctx.runStore.page && url.searchParams.has('limit')) {
    let options;
    try { options = pageOptions(url); } catch (error) { ctx.json(res, 400, { error: error.message }); return true; }
    const page = await ctx.runStore.page(runId, options);
    if (!page) { ctx.json(res, 404, { error: 'run not found' }); return true; }
    const decisions = await new DecisionsStore(ctx.runStore.dir(runId)).effective(page.results, page.groups);
    ctx.json(res, 200, { decisions, page: page.page });
    return true;
  }
  let data;
  if (metadataOnly && ctx.runStore.getRun) {
    const run = await ctx.runStore.getRun(runId);
    data = run ? { run } : null;
  } else if (action !== 'personalize' && url.searchParams.has('groupId') && ctx.runStore.page) {
    data = await ctx.runStore.page(runId, { groupId: url.searchParams.get('groupId') });
  } else data = await ctx.runStore.get(runId, { readOnly: true });
  if (!data) {
    ctx.json(res, 404, { error: "run not found" });
    return true;
  }

  if (req.method === 'GET' && action === 'queue') {
    const mode = url.searchParams.get('mode') || 'all';
    if (!MODES.has(mode)) { ctx.json(res, 400, { error: `未知队列模式：${mode}` }); return true; }
    const queue = await buildQueue(ctx.runStore, runId);
    if (!queue) { ctx.json(res, 404, { error: 'run not found' }); return true; }
    const items = filterQueue(queue.rows, mode);
    ctx.json(res, 200, { mode, queue: items, items, order: queue.rows.map(row => row.unitId), counts: queue.counts,
      total: queue.total });
    return true;
  }

  if (await handleLearningRoute(req, res, ctx, data)) return true;

  if (await handleGroupRoute(req, res, ctx, data)) return true;

  const store = new DecisionsStore(ctx.runStore.dir(runId));
  if (req.method === 'GET' && action === 'review-progress') {
    const groups = ctx.runStore.reviewSummary ? await ctx.runStore.reviewSummary(runId) : data.groups;
    const human = new Set((await store.read()).filter(row => row.source === 'human').map(row => row.unitId));
    ctx.json(res, 200, { total: groups?.length ?? data.run.groupCount ?? 0,
      reviewed: groups ? groups.filter(group => group.unitIds.length && group.unitIds.every(id => human.has(id))).length : null });
    return true;
  }
  if (req.method === 'POST' && ['apply', 'clear'].some(mode => url.pathname === `/runs/${runId}/ai-tags/${mode}`)) {
    const clear = url.pathname.endsWith('/clear');
    return serializeWriteback(ctx, runId, async fresh => {
      ctx.json(res, 200, await writeAiTags(ctx.api, fresh, { clear }));
      return true;
    });
  }
  if (req.method === 'POST' && url.pathname === `/runs/${runId}/writeback/live`) {
    const body = await ctx.readBody(req);
    if (!Array.isArray(body.unitIds) || !body.unitIds.length || body.unitIds.length > 10000 ||
      body.unitIds.some(id => typeof id !== 'string' || !id)) {
      ctx.json(res, 400, { error: 'unitIds must be a non-empty array of unit IDs (maximum 10000)' });
      return true;
    }
    const ids = [...new Set(body.unitIds)];
    return serializeWriteback(ctx, runId, fresh => liveRun(res, ctx, fresh, store, ids, body.star === true), ids);
  }
  if (req.method === "GET" && url.pathname === `/runs/${runId}/personalize`) {
    ctx.json(res, 200, { ...personalizeReport(data, await store.read()),
      applied: appliedPersonalization(await readPersonalizeUndo(ctx.runStore, runId)) });
    return true;
  }
  if (req.method === "POST" && url.pathname === `/runs/${runId}/personalize/apply`) {
    return serializeWriteback(ctx, runId, async fresh => {
      const report = await applyWithUndo(ctx.runStore, fresh, await store.read(), ctx.clock?.().toISOString());
      ctx.json(res, report.ready ? 200 : 409, report.ready ? report
        : { ...report, error: "数据不足或留出集未稳定优于 L0，不能应用偏好" });
      return true;
    });
  }
  if (req.method === "POST" && url.pathname === `/runs/${runId}/personalize/undo`) {
    return serializeWriteback(ctx, runId, async fresh => {
      ctx.json(res, 200, await undoPersonalization(ctx.runStore, fresh));
      return true;
    });
  }
  if (req.method === "GET" && action === "decisions") {
    ctx.json(res, 200, { decisions: await store.effective(data.results, data.groups) });
    return true;
  }
  if (req.method === "POST" && action === "decisions") {
    const body = await ctx.readBody(req);
    const decisions = Array.isArray(body) ? body : body.decisions || [body];
    if (decisions.some(row => typeof row?.unitId !== 'string' || (row.clear !== true && !DECISION_ACTIONS.includes(row.action)))) {
      ctx.json(res, 400, { error: 'decision 需要 unitId 和有效的 action' }); return true;
    }
    const result = await decideUnits(ctx, runId, decisions, Array.isArray(body) ? {} : body.learning || {},
      { stars: wantsStars(req) });
    res.setHeader?.('Server-Timing', result.timing);
    ctx.json(res, 200, { decisions: result.decisions, ...(result.learningWarning ? { learningWarning: result.learningWarning } : {}),
      ...(result.tagWarning ? { tagWarning: result.tagWarning } : {}),
      ...(result.eagleStars ? { eagleStars: result.eagleStars } : {}) });
    return true;
  }
  if (req.method === 'POST' && action === 'eagle-tags') return handleEagleTags(req, res, ctx, runId, data, store);
  if (req.method === "POST" && url.pathname === `/runs/${runId}/writeback/revert`) {
    return serializeWriteback(ctx, runId, fresh => revertRun(req, res, ctx, fresh));
  }
  if (req.method === "POST" && action === "apply") {
    return serializeWriteback(ctx, runId, fresh => applyRun(req, res, ctx, fresh, store));
  }
  if (req.method === "POST" && action === "trash-rejected") {
    return serializeWriteback(ctx, runId, fresh => trashRejected(req, res, ctx, fresh, store));
  }
  if (req.method === "GET" && action === "report") {
    const decisions = await store.effective(data.results, data.groups);
    const rows = buildReport({ ...data, decisions });
    if (url.searchParams.get("format") === "csv") {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", ...CORS_HEADERS });
      res.end(reportCsv(rows));
    } else {
      ctx.json(res, 200, rows);
    }
    return true;
  }
  return false;
}

export async function saveDecisionBatch(ctx, data, store, decisions, context = {}) {
  const timestamp = ctx.clock?.().toISOString();
  const writeStart = performance.now();
  const saved = await store.upsert(decisions.map(row => ({ ...row, ...(timestamp ? { updatedAt: timestamp } : {}) })));
  const decisionsMs = performance.now() - writeStart;
  const learningStart = performance.now();
  let learningWarning;
  try {
    const { dataStore, profiles } = learningServices(ctx);
    const profile = await profiles.loadProfile(context.profileId || 'default');
    const events = await dataStore.recordDecisions(data, saved, { ...context, ...(timestamp ? { timestamp } : {}),
      changedUnitIds: decisions.map(row => row.unitId), modelVersion: profile.head?.version || 'L0',
      weightsVersion: profile.head?.snapshotId || 'L0' });
    if (profile.config.pixelTier === 1) for (const event of events) for (const decision of event.decisions || []) {
      if (decision.action !== 'rejected' || !decision.hash) continue;
      const unit = data.units.find(row => row.id === decision.unitId);
      const item = data.items.find(row => row.id === unit?.primaryItemId);
      await dataStore.retainPixels(decision.hash, { tier: 1, sourcePath: item?.filePath || item?.path });
    }
  } catch (error) { learningWarning = error.message; }
  const learningMs = performance.now() - learningStart;
  const timing = `decisions;dur=${decisionsMs.toFixed(2)}, learning;dur=${learningMs.toFixed(2)}, `
    + `run;dur=${(data.readDurationMs || 0).toFixed(2)}`;
  return { decisions: saved, learningWarning, timing };
}

// Decisions and the task's Eagle tags change in the same per-run queue, so tags never lag a newer decision.
// stars: the plugin records decisions as Eagle ratings (and 留存 as a tag), so each decision also sets them.
// fromStarItem / fromTagItem: a rating or 留存 tag read from that Eagle item; it is checked against the decision current at
// its turn in the queue, because the main window and the inspector both watch Eagle and may report the same change.
// Whether a change seen in Eagle only echoes the saved decision `now`. Removing the tag only undoes 留存.
export function echoUnchanged(now, row, fromTag) {
  if (row.clear && fromTag && now !== 'record') return true;
  return row.clear ? now === undefined : now === row.action;
}

export function decideUnits(ctx, runId, decisions, context = {}, { stars = false, fromStarItem = null, fromTagItem = null } = {}) {
  const store = new DecisionsStore(ctx.runStore.dir(runId));
  const unitIds = decisions.map(row => row.unitId);
  return serializeWriteback(ctx, runId, async data => {
    if (fromStarItem || fromTagItem) {
      const current = new Map((await store.read()).filter(row => row.source === 'human').map(row => [row.unitId, row.action]));
      if (decisions.every(row => echoUnchanged(current.get(row.unitId), row, Boolean(fromTagItem))))
        return { decisions: [], unchanged: true };
    }
    const result = await saveDecisionBatch(ctx, data, store, decisions, context);
    if (data.run?.eagleTagsEnabled) {
      try { await applyLiveUnits(ctx, data, store, [...new Set(unitIds)], false, { suggestions: true }); }
      catch (error) { result.tagWarning = `决定已保存，但 Eagle 标签未更新：${error.message}`; }
    }
    if (stars) {
      // The item Eagle reported from already shows that change; it only needs the other one.
      result.eagleStars = decisionStars(data, decisions).map(({ id, star, record }) =>
        id === fromStarItem ? { id, record } : id === fromTagItem ? { id, star } : { id, star, record });
    }
    return result;
  }, unitIds);
}

// A decision on a photo no finished analysis covers yet: it waits in the pending list until one does.
export async function decidePending(ctx, { libraryPath, itemId }, decision, { stars = false, via = null } = {}) {
  const fromTag = via === 'eagle-tag';
  const result = await ctx.runStore.pendingDecisions.decide(libraryPath, itemId, decision,
    { unchanged: now => Boolean(via) && echoUnchanged(now, decision, fromTag) });
  if (result.unchanged) return { pending: true, itemId, unchanged: true };
  const response = { pending: true, itemId, decision: result.row };
  if (stars) {
    const star = decision.clear ? 0 : ACTION_STARS[decision.action], record = decision.action === 'record';
    response.eagleStars = [via === 'eagle-star' ? { id: itemId, record } : fromTag ? { id: itemId, star }
      : { id: itemId, star, record }];
  }
  return response;
}

// The plugin applies these through Eagle's item API to keep the native grid in sync: a star, and whether it has 留存.
export function decisionStars(data, decisions) {
  const units = new Map(data.units.map(unit => [unit.id, unit]));
  return decisions.flatMap(row => {
    const star = row.clear ? 0 : ACTION_STARS[row.action];
    const unit = units.get(row.unitId);
    return star === undefined || !unit ? [] : (unit.itemIds || [unit.primaryItemId]).filter(Boolean)
      .map(id => ({ id, star, record: row.action === 'record' }));
  });
}

async function serializeWriteback(ctx, runId, operation, unitIds) {
  const pending = ctx.writebackPending ||= new Map();
  const previous = pending.get(runId) || Promise.resolve();
  const task = previous.then(async () => {
    const readStart = performance.now();
    const data = unitIds && ctx.runStore.selection ? await ctx.runStore.selection(runId, unitIds)
      : await ctx.runStore.get(runId, { readOnly: true });
    if (data) data.readDurationMs = performance.now() - readStart;
    if (!data) throw new Error("run not found");
    return operation(data);
  });
  const queued = task.catch(() => {});
  pending.set(runId, queued);
  try {
    return await task;
  } finally {
    if (pending.get(runId) === queued) pending.delete(runId);
  }
}

async function applyRun(req, res, ctx, data, store) {
  const body = await ctx.readBody(req);
  if (body.moveRejectedToTrash && body.confirm !== "MOVE_TO_TRASH") {
    ctx.json(res, 400, { error: "moveRejectedToTrash requires confirm MOVE_TO_TRASH" });
    return true;
  }
  const decisions = await store.effective(data.results, data.groups);
  const live = await liveItems(ctx.api, data, body.apply === true);
  const plan = planWriteback({ ...data, items: live.items, decisions });
  const result = await applyWriteback(plan, ctx.api, { apply: body.apply === true });
  result.liveTags = live.live;
  if (live.warning) result.warning = live.warning;
  if (body.moveRejectedToTrash && body.confirm === "MOVE_TO_TRASH") {
    const ids = plan.items.filter(item => item.action === "rejected").map(item => item.id);
    result.trash = body.apply
      ? await moveToTrash(ctx.api, ids)
      : { dryRun: true, ids };
  }
  if (body.apply === true) {
    const records = writebackRecords(plan, result);
    const hasLiveHistory = data.applied?.some(record => record.live && !record.revertedAt);
    await ctx.runStore.saveApplied(data.run.id, hasLiveHistory ? mergeWritebackRecords(data.applied, records) : records);
  }
  ctx.json(res, 200, result);
  return true;
}

async function handleEagleTags(req, res, ctx, runId, data, store) {
  const body = await ctx.readBody(req);
  if (typeof body.enabled !== 'boolean') { ctx.json(res, 400, { error: 'enabled 必须是布尔值' }); return true; }
  return serializeWriteback(ctx, runId, async fresh => {
    if (!ctx.api?.itemInfo || !ctx.api?.updateItem) throw new Error('当前 Eagle API 不支持标签写回');
    if (fresh.run.libraryPath && ctx.api.assertLibrary) await ctx.api.assertLibrary(fresh.run.libraryPath);
    let result;
    if (body.enabled) {
      const live = await liveItems(ctx.api, fresh, true);
      const decisions = await store.effective(fresh.results, fresh.groups);
      const plan = planWriteback({ ...fresh, items: live.items, decisions });
      result = await applyWriteback(plan, ctx.api, { apply: true });
      const records = writebackRecords(plan, result);
      await ctx.runStore.saveApplied(runId, mergeWritebackRecords(fresh.applied || [], records));
      result.liveTags = true;
    } else {
      const applied = (fresh.applied || []).filter(record => !record.revertedAt);
      if (!applied.length) result = { dryRun: false, summary: {}, results: [], revert: true };
      else {
        const live = await liveItems(ctx.api, { ...fresh, items: applied.map(record => ({ id: record.id, name: record.fileName })) }, true);
        const plan = planRevertWriteback({ applied, items: live.items });
        result = await applyWriteback(plan, ctx.api, { apply: true });
        await ctx.runStore.saveApplied(runId, revertedRecords(fresh.applied || [], result));
        result.revert = true;
      }
    }
    const run = { ...fresh.run, eagleTagsEnabled: body.enabled };
    if (ctx.runStore.saveProgress) await ctx.runStore.saveProgress(run);
    else await ctx.runStore.save(run, { run }, { metadataOnly: true });
    ctx.json(res, 200, { ...result, enabled: body.enabled });
    return true;
  });
}

async function liveRun(res, ctx, data, store, unitIds, star) {
  let result;
  try { result = await applyLiveUnits(ctx, data, store, unitIds, star); }
  catch (error) { ctx.json(res, 400, { error: error.message }); return true; }
  ctx.json(res, 200, result);
  return true;
}

// suggestions: the task shows AI suggestions in Eagle, so undecided units carry their suggestion tags.
export async function applyLiveUnits(ctx, data, store, unitIds, star = false, { suggestions = false } = {}) {
  const wanted = new Set(unitIds);
  const units = data.units.filter(unit => wanted.has(unit.id));
  const itemIds = new Set(units.flatMap(unit => unit.itemIds || [unit.primaryItemId]));
  const scoped = { ...data, units, results: data.results.filter(row => wanted.has(row.unitId)),
    items: data.items.filter(item => itemIds.has(item.id) || wanted.has(item.unitId)) };
  if (units.length !== wanted.size) {
    throw new Error('Unknown unit ID');
  }
  const applied = ctx.runStore.applied ? await ctx.runStore.applied(data.run.id) : data.applied || [];
  const decisions = await store.effective(scoped.results, scoped.groups);
  const human = new Set(decisions.filter(row => suggestions || row.source === 'human').map(row => row.unitId));
  const live = await liveItems(ctx.api, scoped, true);
  const plan = addLiveStars(planWriteback({ ...scoped, items: live.items,
    results: scoped.results.filter(row => human.has(row.unitId)), decisions }), live.items, star);
  // Clearing a human decision restores the baseline, rather than committing an AI suggestion.
  const clearedItems = new Set(units.filter(unit => !human.has(unit.id)).flatMap(unit => unit.itemIds || [unit.primaryItemId]));
  const cleared = applied.filter(record => !record.revertedAt && clearedItems.has(record.id));
  if (cleared.length) plan.items.push(...planRevertWriteback({ applied: cleared, items: live.items }).items);
  // Rebuild exact counts after joining normal and undo plans.
  plan.changed = plan.items.filter(row => row.changed);
  plan.unchanged = plan.items.filter(row => !row.changed);
  plan.summary = summarizeWriteback(plan.items);
  const result = await applyWriteback(plan, ctx.api, { apply: true });
  const records = writebackRecords(plan, result).map(record => ({ ...record, live: true }));
  await ctx.runStore.saveApplied(data.run.id, mergeWritebackRecords(applied, records));
  return { ...result, liveTags: true };
}

async function revertRun(req, res, ctx, data) {
  const body = await ctx.readBody(req);
  validateRevertRecords(data.applied);
  if (!ctx.api?.itemInfo) throw new Error("撤回必须读取 Eagle 当前标签");
  const items = data.applied.map(record => ({ id: record.id, name: record.fileName }));
  const live = await liveItems(ctx.api, { ...data, items }, true, true);
  const plan = planRevertWriteback({ applied: data.applied, items: live.items });
  const execute = body.apply !== false;
  const result = await applyWriteback(plan, ctx.api, { apply: execute });
  result.revert = true;
  result.liveTags = live.live;
  if (execute) await ctx.runStore.saveApplied(data.run.id, revertedRecords(data.applied, result));
  ctx.json(res, 200, result);
  return true;
}

async function liveItems(api, data, apply, requireTags = true) {
  try {
    if (api?.assertLibrary && data.run?.libraryPath) await api.assertLibrary(data.run.libraryPath);
    return await withLiveTags(data.items, api, { requireTags });
  } catch (error) {
    if (apply) throw error;
    return { items: data.items, live: false, warning: `无法读取 Eagle 当前标签，预览基于分析时快照：${error.message}` };
  }
}

// Only photos the user marked 淘汰 go to Eagle's trash, never undecided photos the AI suggests rejecting. Files no longer
// in the library (or already in its trash) are skipped so one stale ID cannot fail the batch.
async function trashRejected(req, res, ctx, data, store) {
  const body = await ctx.readBody(req);
  const apply = body.apply === true;
  if (apply && body.confirm !== "MOVE_TO_TRASH") {
    ctx.json(res, 400, { error: "移入回收站需要 confirm MOVE_TO_TRASH" });
    return true;
  }
  const rejected = new Set((await store.read()).filter(row => row.source === "human" && row.action === "rejected")
    .map(row => row.unitId));
  const units = (data.units || []).filter(unit => rejected.has(unit.id));
  const ids = [...new Set(units.flatMap(unit => unit.itemIds || [unit.primaryItemId]).filter(Boolean))];
  if (apply && (!ctx.api?.assertLibrary || !ctx.api?.itemInfo || !ctx.api?.moveToTrash || !data.run.libraryPath)) {
    throw new Error("无法确认 Eagle 资源库，未移动任何照片");
  }
  let present = ids, verified = false;
  if (ctx.api?.itemInfo) {
    try {
      if (ctx.api.assertLibrary && data.run.libraryPath) await ctx.api.assertLibrary(data.run.libraryPath);
      present = [];
      for (const id of ids) {
        const info = await ctx.api.itemInfo(id).catch(() => null);
        if (info && !info.isDeleted) present.push(id);
      }
      verified = true;
    } catch (error) {
      if (apply) throw error;
      present = ids;
    }
  }
  const names = new Map((data.items || []).map(item => {
    const name = item.name || item.fileName || item.id;
    return [item.id, item.ext && !name.toLowerCase().endsWith(`.${item.ext}`.toLowerCase()) ? `${name}.${item.ext}` : name];
  }));
  const result = { dryRun: !apply, verified, units: units.length, count: present.length, skipped: ids.length - present.length,
    files: present.slice(0, 50).map(id => names.get(id) || id) };
  if (apply) result.trash = await moveToTrash(ctx.api, present);
  ctx.json(res, 200, result);
  return true;
}

async function moveToTrash(api, ids) {
  if (!ids.length) return [];
  try {
    await api.moveToTrash(ids);
    return ids.map(id => ({ id, ok: true }));
  } catch (error) {
    return ids.map(id => ({ id, ok: false, error: error.message }));
  }
}

export async function writeAiTags(api, data, { clear = false } = {}) {
  if (!api?.itemInfo || !api?.updateItem || !api?.assertLibrary || !data.run.libraryPath) {
    throw new Error('无法确认 Eagle 资源库，未写入 AI 标签');
  }
  await api.assertLibrary(data.run.libraryPath);
  const assigned = new Map();
  for (const unit of data.units || []) {
    const result = data.results?.find(row => row.unitId === unit.id) || { unitId: unit.id };
    const tags = clear ? [] : resultAiTags(data, result).map(row => row.tag).filter(tag => tag?.startsWith('AI·'));
    for (const id of unit.itemIds || [unit.primaryItemId]) if (id) assigned.set(id, tags);
  }
  const plan = [];
  for (const [id, tags] of assigned) {
    const item = await api.itemInfo(id);
    if (!item || !Array.isArray(item.tags)) throw new Error('无法读取当前 Eagle 标签，未开始写入');
    const next = [...new Set([...item.tags.filter(tag => !tag.startsWith('AI·')), ...tags])];
    if (JSON.stringify(item.tags) !== JSON.stringify(next)) plan.push({ id, tags: next });
  }
  const results = [];
  for (const row of plan) {
    await api.assertLibrary(data.run.libraryPath);
    try { await api.updateItem(row); results.push({ id: row.id, ok: true }); }
    catch (error) { results.push({ id: row.id, ok: false, error: error.message }); }
  }
  return { total: assigned.size, updated: results.filter(row => row.ok).length,
    failed: results.filter(row => !row.ok).length, results };
}
