import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { FeedbackStore, feedbackStats, effectiveFeedback } from "./feedback-store.js";
import { gateFlags, SERIOUS_RANKING_FLAGS } from "../core/ranking.js";

let catalogCache;
const rulesRoot = new URL("../rules/", import.meta.url);
export async function feedbackCatalog() {
  const folders = [rulesRoot, new URL("candidates/", rulesRoot)];
  const files = [];
  for (const folder of folders) for (const name of (await readdir(folder)).filter(name => name.endsWith(".json"))) {
    const file = new URL(name, folder), metadata = await stat(file);
    files.push([file.href, metadata.size, metadata.mtimeMs, metadata.ctimeMs]);
  }
  const signature = JSON.stringify(files);
  if (catalogCache?.signature === signature) return structuredClone(catalogCache.value);
  const vocabulary = JSON.parse(await readFile(new URL("reject-reasons.json", rulesRoot), "utf8"));
  const rules = new Map();
  for (const folder of [rulesRoot, new URL("candidates/", rulesRoot)]) {
    for (const file of (await readdir(folder)).filter(name => name.endsWith(".json") && name !== "reject-reasons.json")) {
      const library = JSON.parse(await readFile(new URL(file, folder), "utf8"));
      for (const rule of library.rules || []) {
        // Current libraries win over proposed rules and evidence-only metadata.
        if (!rule.id || rules.has(rule.id)) continue;
        rules.set(rule.id, {
          id: rule.id, title: rule.title || rule.label || rule.id,
          label: rule.label || rule.title || rule.id,
          severity: rule.severity, hint: rule.statement || ""
        });
      }
    }
  }
  const value = { contractVersion: 1, reasons: vocabulary.reasons, rules: [...rules.values()] };
  catalogCache = { signature, value };
  return structuredClone(value);
}

export async function handleFeedbackRoute(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([A-Za-z0-9_-]+)\/feedback$/);
  if (!match && !["/api/feedback/stats", "/api/feedback/catalog"].includes(url.pathname)) return false;
  if (req.method === "GET" && url.pathname === "/api/feedback/catalog") {
    ctx.json(res, 200, await feedbackCatalog()); return true;
  }
  const store = ctx.feedbackStore ||= new FeedbackStore(path.join(ctx.runStore.root || "data/runs", "../feedback"));
  if (req.method === "GET" && url.pathname === "/api/feedback/stats") {
    const runId = url.searchParams.get("runId");
    if (runId && !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("invalid run ID");
    const data = runId ? await ctx.runStore.get(runId) : null;
    if (runId && !data) { ctx.json(res, 404, { error: "run not found" }); return true; }
    const events = await store.read(data?.run.libraryPath);
    ctx.json(res, 200, feedbackStats(runId ? events.filter(event => event.runId === runId) : events, (await feedbackCatalog()).reasons));
    return true;
  }
  if (req.method !== "POST" || !match) return false;
  const runId = match[1];
  // Feedback validates one unit and its current group; do not repeatedly parse
  // every embedding while the UI's feedback queue drains.
  if (ctx.runStore.unitData && !await ctx.runStore.getRun(runId)) {
    ctx.json(res, 404, { error: "run not found" }); return true;
  }
  const body = await ctx.readBody(req);
  const data = ctx.runStore.unitData ? await ctx.runStore.unitData(runId, body.unitId) : await ctx.runStore.get(runId);
  if (!data) { ctx.json(res, 404, { error: "run not found" }); return true; }
  const unit = data.units.find(unit => unit.id === body.unitId);
  if (!unit) throw new Error("feedback unit not found");
  if (!["keep", "reject", "winner-change", "undo"].includes(body.action)) throw new Error("invalid feedback action");
  const catalog = await feedbackCatalog();
  const reasonIds = new Set(catalog.reasons.map(reason => reason.id));
  if (!Array.isArray(body.reasons || []) || (body.reasons || []).some(id => !reasonIds.has(id)))
    throw new Error("invalid feedback reasons");
  const group = data.groups.find(group => group.unitIds.includes(unit.id));
  if (body.action === "winner-change" && (!group
    || !group.unitIds.includes(body.prevWinner)
    || !group.unitIds.includes(body.newWinner)
    || body.prevWinner === body.newWinner || body.newWinner !== unit.id)) throw new Error("invalid winner pair");
  const result = data.results.find(result => result.unitId === unit.id) || {};
  const verdicts = result.verdicts || [];
  const violations = [...new Set(verdicts.filter(verdict => verdict.verdict === "violate").map(verdict => verdict.ruleId))];
  const gates = [...new Set([
    ...gateFlags(result).filter(flag => SERIOUS_RANKING_FLAGS.includes(flag)),
    ...violations.filter(id => catalog.rules.some(rule => rule.id === id && rule.severity === "gate"))
  ])];
  const suggestion = group?.suggested?.[unit.id];
  const decision = suggestion === "rejected" ? "reject"
    : suggestion === "selected" ? "keep"
    : suggestion === "candidate" ? "keep" : gates.length ? "reject" : "unknown";
  const analysisSignature = data.run.analysisSignature || data.analysisSignature || createHash("sha256")
    .update(JSON.stringify(data.results.map(result => [result.unitId, result.fingerprint || null]))).digest("hex");
  const event = {
    runId, analysisSignature,
    unitId: unit.id, itemIds: [...unit.itemIds], action: body.action, reasons: [...new Set(body.reasons || [])],
    toolSuggestion: { decision, gates, violations },
  };
  if (body.action === "winner-change") Object.assign(event, { prevWinner: body.prevWinner, newWinner: body.newWinner });
  for (const key of ["undoOf", "replaces"]) if (body[key]) event[key] = body[key];
  if (body.action === "undo" && !body.undoOf) throw new Error("undo requires undoOf");
  if (body.action !== "undo" && body.undoOf) throw new Error("undoOf requires undo action");
  if (body.action === "undo" && body.replaces) throw new Error("undo cannot replace an event");
  const record = await store.append(data.run.libraryPath, event, events => {
    for (const key of ["undoOf", "replaces"]) {
      if (!event[key]) continue;
      const target = effectiveFeedback(events).find(candidate => candidate.id === event[key]);
      if (!target || target.runId !== runId || target.unitId !== unit.id)
        throw new Error("feedback reference is not an active event for this unit");
      if (key === "replaces" && target.action !== event.action) throw new Error("replacement action must match");
    }
  });
  ctx.json(res, 201, { event: record });
  return true;
}
