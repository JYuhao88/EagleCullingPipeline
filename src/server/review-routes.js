import { streamReport } from "./stream-report.js";
import { pageOptions } from "./pagination.js";
import { handleLearningRoute, learningServices } from "./learning-routes.js";
import { handleFeedbackRoute } from "./feedback-routes.js";
import { DecisionsStore } from "../core/decisions-store.js";
import {
  planWriteback, applyWriteback, withLiveTags, planRevertWriteback,
  validateRevertRecords, writebackRecords, revertedRecords
} from "../core/writeback.js";
import { handleGroupRoute } from "./group-routes.js";
import { buildReport, reportCsv } from "../core/report.js";
import { applyPersonalization, personalizeReport } from "../core/personalize.js";
import { CORS_HEADERS } from "./http.js";

export async function handleReviewRoute(req, res, ctx) {
  if (await handleFeedbackRoute(req, res, ctx)) return true;
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return false;
  const [, runId, action] = match;
  // Mutations reload the current full state inside their run queue. Training
  // and status only need the run identity; neither should parse all embeddings.
  const metadataOnly = req.method === "POST" && action === "decisions" ||
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
  } else if (url.searchParams.has('groupId') && ctx.runStore.page) {
    data = await ctx.runStore.page(runId, { groupId: url.searchParams.get('groupId') });
  } else data = await ctx.runStore.get(runId, { readOnly: true });
  if (!data) {
    ctx.json(res, 404, { error: "run not found" });
    return true;
  }

  if (await handleLearningRoute(req, res, ctx, data)) return true;

  if (await handleGroupRoute(req, res, ctx, data)) return true;

  const store = new DecisionsStore(ctx.runStore.dir(runId));
  if (req.method === "GET" && url.pathname === `/runs/${runId}/personalize`) {
    ctx.json(res, 200, personalizeReport(data, await store.read()));
    return true;
  }
  if (req.method === "POST" && url.pathname === `/runs/${runId}/personalize/apply`) {
    const result = applyPersonalization(data, await store.read());
    const { data: updated, ...report } = result;
    if (!result.ready) {
      ctx.json(res, 409, { ...report, error: "数据不足或留出集未稳定优于 L0，不能应用偏好" });
      return true;
    }
    if (result.changedGroups) await ctx.runStore.save(data.run, updated);
    ctx.json(res, 200, report);
    return true;
  }
  if (req.method === "GET" && action === "decisions") {
    ctx.json(res, 200, { decisions: await store.effective(data.results, data.groups) });
    return true;
  }
  if (req.method === "POST" && action === "decisions") {
    // Keep the persisted decision and its learning snapshot in request order.
    const body = await ctx.readBody(req);
    const decisions = Array.isArray(body) ? body : body.decisions || [body];
    return serializeWriteback(ctx, runId, async data => {
      const timestamp = ctx.clock?.().toISOString();
      const writeStart = performance.now();
      const saved = await store.upsert(decisions.map(row => ({ ...row,
        ...(timestamp ? { updatedAt: timestamp } : {}) })));
      const decisionsMs = performance.now() - writeStart;
      const learningStart = performance.now();
      let learningWarning;
      try {
        const { dataStore, profiles } = learningServices(ctx);
        const context = Array.isArray(body) ? {} : body.learning || {};
        const profile = await profiles.loadProfile(context.profileId || 'default');
        const events = await dataStore.recordDecisions(data, saved, { ...context,
          ...(timestamp ? { timestamp } : {}),
          changedUnitIds: decisions.map(row => row.unitId),
          modelVersion: profile.head?.version || 'L0', weightsVersion: profile.head?.snapshotId || 'L0' });
        if (profile.config.pixelTier === 1) {
          for (const event of events) for (const decision of event.decisions || []) {
            if (decision.action !== 'rejected' || !decision.hash) continue;
            const unit = data.units.find(row => row.id === decision.unitId);
            const item = data.items.find(row => row.id === unit?.primaryItemId);
            await dataStore.retainPixels(decision.hash, { tier: 1, sourcePath: item?.filePath || item?.path });
          }
        }
      } catch (error) { learningWarning = error.message; }
      const learningMs = performance.now() - learningStart;
      res.setHeader?.("Server-Timing", `decisions;dur=${decisionsMs.toFixed(2)}, learning;dur=${learningMs.toFixed(2)}, `
        + `run;dur=${(data.readDurationMs || 0).toFixed(2)}`);
      ctx.json(res, 200, { decisions: saved, ...(learningWarning ? { learningWarning } : {}) });
      return true;
    }, decisions.map(row => row.unitId));
  }
  if (req.method === "POST" && url.pathname === `/runs/${runId}/writeback/revert`) {
    return serializeWriteback(ctx, runId, fresh => revertRun(req, res, ctx, fresh));
  }
  if (req.method === "POST" && action === "apply") {
    return serializeWriteback(ctx, runId, fresh => applyRun(req, res, ctx, fresh, store));
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
    await ctx.runStore.saveApplied(data.run.id, writebackRecords(plan, result));
  }
  ctx.json(res, 200, result);
  return true;
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

async function moveToTrash(api, ids) {
  if (!ids.length) return [];
  try {
    await api.moveToTrash(ids);
    return ids.map(id => ({ id, ok: true }));
  } catch (error) {
    return ids.map(id => ({ id, ok: false, error: error.message }));
  }
}
