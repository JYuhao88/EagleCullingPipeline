/**
 * Group candidate selection.  This is deliberately separate from ranking:
 * ranking still supplies the backwards-compatible default suggestion while
 * this module describes the set a reviewer may want to keep side by side.
 */
import { createRequire } from "node:module";
import { rulePenalty } from "./ranking.js";

const require = createRequire(import.meta.url);
const config = require("./pareto-config.json");

export const CANDIDATE_CONFIG = Object.freeze(config);
export const CANDIDATE_DIMENSIONS = Object.freeze(Object.keys(config.dimensions));
const SERIOUS_FLAGS = new Set(config.seriousFlags);

const finite = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;

function eyes(item) {
  const faces = item.metrics?.faces;
  const closed = item.metrics?.eyesClosed;
  return Number.isFinite(faces) && faces > 0 && Number.isFinite(closed)
    ? finite(1 - Math.min(1, closed / faces)) : null;
}

function crop(item) {
  const violations = (item.verdicts || []).filter(v => v.by === "measure" && v.verdict === "violate");
  if (!violations.length) return item.signals?.persons?.length ? 1 : null;
  const penalty = violations.reduce((sum, v) => sum + (config.cropPenalties[v.ruleId] ?? config.cropPenalty), 0);
  return finite(1 - Math.min(1, penalty));
}

/** Return normalized, explainable objectives. Missing signals remain unknown. */
export function candidateDimensions(item) {
  const metrics = item?.metrics || {};
  return {
    sharpness: finite(metrics.sharpness),
    exposure: finite(metrics.exposureSuitability ?? metrics.exposure ?? item?.exposure),
    eyes: eyes(item),
    composition: crop(item),
    quality: finite(metrics.quality),
    aesthetic: finite(metrics.aesthetic),
    // Convert the existing additive rule penalty to a maximized objective.
    penalty: finite(1 - Math.min(1, rulePenalty(item) / 0.1)),
  };
}

function dominates(a, b, epsilon) {
  const shared = CANDIDATE_DIMENSIONS.filter(key => a[key] !== null && b[key] !== null);
  if (!shared.length) return false;
  const noWorse = shared.every(key => a[key] + epsilon[key] >= b[key]);
  const better = shared.some(key => a[key] > b[key] + epsilon[key]);
  return noWorse && better;
}

function severe(item) {
  return [...new Set([...(item.flags || []), ...(item.qualityFlags || [])])]
    .some(flag => SERIOUS_FLAGS.has(flag));
}

function leaderLabels(rows) {
  const labels = {
    sharpness: "清晰度领先", exposure: "曝光领先", eyes: "表情/眼睛领先",
    composition: "构图裁切领先", quality: "TOPIQ 质量领先", aesthetic: "审美分领先", penalty: "规则风险较低",
  };
  return rows.map(row => {
    const leaders = CANDIDATE_DIMENSIONS.filter(key => row.dimensions[key] !== null &&
      row.dimensions[key] >= Math.max(...rows.map(other => other.dimensions[key] ?? -Infinity)) - 1e-9)
      .map(key => labels[key]);
    return { ...row, leaders };
  });
}

/** Build an epsilon-Pareto set. No fallback winner is created. */
export function buildCandidateSet(items, options = {}) {
  const epsilon = { ...config.epsilon, ...(options.epsilon || {}) };
  const rows = leaderLabels((items || []).map(item => ({
    unitId: item.unitId || item.id,
    dimensions: candidateDimensions(item),
    hardRejected: severe(item),
  })));
  const eligible = rows.filter(row => !row.hardRejected);
  const usable = eligible.length ? eligible : rows;
  const rejectedAll = eligible.length === 0 && rows.length > 0;
  const frontier = rejectedAll ? [] : usable.filter(row => !usable.some(other =>
    other.unitId !== row.unitId && dominates(other.dimensions, row.dimensions, epsilon)));
  const selected = frontier.length ? frontier : (rejectedAll ? [] : usable.slice(0, 1));
  return {
    contractVersion: 1,
    mode: "epsilon-pareto",
    dimensions: CANDIDATE_DIMENSIONS,
    epsilon,
    unitIds: selected.map(row => row.unitId),
    entries: rows.map(row => ({ ...row, candidate: selected.some(x => x.unitId === row.unitId) })),
    rejectedAll,
    reason: rejectedAll ? "全组都有严重硬伤" : null,
  };
}

export function candidateDecisionSuggestions(candidateSet) {
  return Object.fromEntries((candidateSet?.entries || []).map(entry => [
    entry.unitId,
    candidateSet.rejectedAll ? "rejected" : entry.candidate ? "candidate" : "rejected",
  ]));
}
