import { ACTION_TAGS, AI_TAGS, FLAG_TAGS } from "./writeback.js";

const columns = [
  "itemId", "fileName", "ext", "unitId", "pairing", "groupId", "groupSize",
  "rank", "score", "sharpness", "exposure", "clippedHighlights",
  "clippedShadows", "faces", "eyesClosed", "quality", "aesthetic", "flags",
  "reasons", "suggested", "decision", "decisionSource", "decisionReason", "tags", "tagsSource"
];

export function buildReport({ units = [], results = [], groups = [], items = [], decisions = [], applied = [] }) {
  const unitMap = new Map(units.map(unit => [unit.id, unit]));
  const resultMap = new Map(results.map(result => [result.unitId, result]));
  const decisionMap = new Map(decisions.map(decision => [decision.unitId, decision]));
  const appliedMap = new Map(applied.map(item => [item.id || item.itemId, item.tags || []]));
  const rows = [];

  for (const group of groups) {
    for (const entry of group.ranking || []) {
      const result = resultMap.get(entry.unitId) || {};
      const unit = unitMap.get(entry.unitId) || {};
      const decision = decisionMap.get(entry.unitId) || {
        action: group.suggested?.[entry.unitId] || "candidate",
        source: "suggested",
        flags: []
      };
      const members = items.filter(item =>
        unit.itemIds?.includes(item.id) || item.unitId === entry.unitId
      );
      for (const item of members) {
        rows.push(makeRow(item, unit, result, group, entry, decision, appliedMap));
      }
    }
  }
  return rows;
}

function makeRow(item, unit, result, group, entry, decision, appliedMap) {
  const metrics = result.metrics || {};
  const metricRows = Object.fromEntries([
    "sharpness", "exposure", "clippedHighlights", "clippedShadows",
    "faces", "eyesClosed", "quality", "aesthetic"
  ].map(key => [key, roundNumber(metrics[key])]));
  const hasApplied = appliedMap.has(item.id);
  const tags = hasApplied ? appliedMap.get(item.id) : plannedTags(item, result, decision);
  return {
    itemId: item.id,
    fileName: item.name || item.fileName || "",
    ext: item.ext || "",
    unitId: unit.id || result.unitId,
    pairing: unit.pairing || "single",
    groupId: group.id || "",
    groupSize: group.unitIds?.length || 1,
    rank: roundNumber(entry.rank),
    score: roundNumber(entry.score ?? result.score),
    ...metricRows,
    flags: (result.flags || []).join("；"),
    reasons: (entry.reasons || []).join("；"),
    suggested: group.suggested?.[result.unitId] || "",
    decision: decision.action || "",
    decisionSource: decision.source || "suggested",
    decisionReason: decision.reason || "",
    tags: tags.join("；"),
    tagsSource: hasApplied ? "applied" : "planned"
  };
}

function plannedTags(item, result, decision) {
  const preserved = (item.tags || []).filter(tag => !AI_TAGS.has(tag));
  const flags = [...new Set([...(result.flags || []), ...(decision.flags || [])])];
  return [...new Set([
    ...preserved,
    ACTION_TAGS[decision.action],
    ...flags.map(flag => FLAG_TAGS[flag]).filter(Boolean)
  ])].filter(Boolean);
}

function roundNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function reportJson(rows) {
  return JSON.stringify(rows, null, 2);
}

export function reportCsv(rows) {
  const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const body = rows.map(row => columns.map(column => escape(row[column])).join(","));
  return `\uFEFF${columns.join(",")}\n${body.join("\n")}\n`;
}

export { columns as reportColumns };
