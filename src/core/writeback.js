import { RECORD_TAG } from "../plugin/star-sync.js";

const ACTION_TAGS = {
  selected: "AI精选",
  candidate: "AI候选",
  rejected: "AI淘汰"
};

const FLAG_TAGS = {
  "eyes-closed": "AI闭眼",
  "possibly-blurry": "AI模糊",
  blurry: "AI模糊",
  overexposed: "AI过曝",
  underexposed: "AI欠曝"
};

const AI_TAGS = new Set([
  ...Object.values(ACTION_TAGS),
  ...Object.values(FLAG_TAGS)
]);

// Tag names written by pre-1.0 plugin builds; cleared together with AI_TAGS.
const LEGACY_AI_TAGS = new Set(["AI待淘汰", "AI原片", "AI已配对", "AI配对待确认", "AI未配对原片",
  "AI可能模糊", "AI低分辨率", "待复核"]);
const CLEARABLE_TAGS = new Set([...AI_TAGS, ...LEGACY_AI_TAGS]);

export function planWriteback({
  results = [],
  decisions = [],
  items = [],
  groups = [],
  units = []
}) {
  const byUnit = new Map(decisions.map(decision => [decision.unitId, decision]));
  const resultByUnit = new Map(results.map(result => [result.unitId, result]));
  const unitItems = new Map(units.map(unit => [unit.id, unit.itemIds || []]));
  const rows = [];

  for (const result of results) {
    const decision = byUnit.get(result.unitId) || {
      unitId: result.unitId,
      action: suggestedFor(result.unitId, groups),
      flags: [],
      source: "suggested"
    };
    const flags = [...new Set([...(result.flags || []), ...(decision.flags || [])])];
    const targetTags = [
      ACTION_TAGS[decision.action],
      ...flags.map(flag => FLAG_TAGS[flag]).filter(Boolean),
      // The plugin writes 留存 itself; listing it here keeps a tag rewrite from dropping it.
      decision.action === "record" ? RECORD_TAG : null
    ];
    const members = items.filter(item =>
      (unitItems.get(result.unitId) || []).includes(item.id) ||
      result.unitId === item.unitId ||
      (result.itemIds || []).includes(item.id) ||
      (decision.itemIds || []).includes(item.id)
    );
    for (const item of members) rows.push(planItem(item, result, decision, targetTags));
  }

  for (const item of items) {
    if (rows.some(row => row.id === item.id) || !item.unitId) continue;
    const result = resultByUnit.get(item.unitId);
    if (result) rows.push(planItem(item, result, byUnit.get(item.unitId) || {}, []));
  }

  return {
    items: rows,
    changed: rows.filter(row => row.changed),
    unchanged: rows.filter(row => !row.changed),
    summary: summarizeWriteback(rows)
  };
}

function suggestedFor(unitId, groups) {
  for (const group of groups) {
    if (group.suggested?.[unitId]) return group.suggested[unitId];
  }
  return "candidate";
}

function planItem(item, result, decision, targetTags) {
  const previousTags = Array.isArray(item.tags) ? item.tags : [];
  const preserved = previousTags.filter(tag => !AI_TAGS.has(tag));
  const tags = [...new Set([...preserved, ...targetTags.filter(Boolean)])];
  return {
    id: item.id,
    itemId: item.id,
    fileName: item.name || item.fileName || item.id,
    unitId: result.unitId,
    action: decision.action,
    tags,
    previousTags,
    ...tagChanges(previousTags, tags)
  };
}

function tagChanges(previousTags, tags) {
  const addedTags = tags.filter(tag => AI_TAGS.has(tag) && !previousTags.includes(tag));
  const removedTags = previousTags.filter(tag => AI_TAGS.has(tag) && !tags.includes(tag));
  return { addedTags, removedTags, changed: addedTags.length > 0 || removedTags.length > 0 };
}

export function summarizeWriteback(rows) {
  return rows.reduce((summary, row) => {
    summary[row.changed ? "changed" : "unchanged"] += 1;
    summary.addedTags += row.addedTags.length;
    summary.removedTags += row.removedTags.length;
    const action = row.action || "revert";
    const bucket = summary.byAction[action] ||= { changed: 0, unchanged: 0, addedTags: 0, removedTags: 0 };
    bucket[row.changed ? "changed" : "unchanged"] += 1;
    bucket.addedTags += row.addedTags.length;
    bucket.removedTags += row.removedTags.length;
    for (const tag of row.tags) {
      if (AI_TAGS.has(tag)) summary.tags[tag] = (summary.tags[tag] || 0) + 1;
    }
    return summary;
  }, { changed: 0, unchanged: 0, addedTags: 0, removedTags: 0, tags: {}, byAction: {} });
}

export function validateRevertRecords(applied = []) {
  if (!applied.length) throw new Error("没有可撤回的写回记录");
  if (applied.some(record => !Array.isArray(record.previousTags))) {
    throw new Error("旧写回记录缺少 previousTags，无法安全撤回；请使用包含写回前标签的新记录");
  }
}

export function planRevertWriteback({ applied = [], items = [] }) {
  validateRevertRecords(applied);
  const byId = new Map(items.map(item => [item.id, item]));
  const rows = applied.map(record => {
    const item = byId.get(record.id);
    if (!item) throw new Error(`撤回缺少文件的当前标签：${record.id}`);
    const previousTags = Array.isArray(item.tags) ? item.tags : [];
    const tags = record.revertedAt ? previousTags : [...new Set([
      ...previousTags.filter(tag => !AI_TAGS.has(tag)),
      ...record.previousTags.filter(tag => AI_TAGS.has(tag))
    ])];
    return {
      id: record.id,
      fileName: record.fileName || item.name || item.fileName || record.id,
      action: "revert",
      previousTags,
      tags,
      ...tagChanges(previousTags, tags),
      ...(!record.revertedAt && record.previousStar !== undefined && item.star === record.star
        ? { star: record.previousStar, previousStar: item.star, changed: true } : {})
    };
  });
  return {
    items: rows, changed: rows.filter(row => row.changed),
    unchanged: rows.filter(row => !row.changed), summary: summarizeWriteback(rows)
  };
}

export function writebackRecords(plan, result) {
  const successful = new Set(result.results.filter(row => row.ok).map(row => row.id));
  return plan.items.filter(item => successful.has(item.id)).map(item => ({
    id: item.id,
    fileName: item.fileName,
    tags: item.tags,
    previousTags: item.previousTags,
    ...(item.star !== undefined ? { star: item.star, previousStar: item.previousStar } : {})
  }));
}

export function revertedRecords(applied, result) {
  const successful = new Map(result.results.filter(row => row.ok).map(row => [row.id, row]));
  return applied.map(record => successful.has(record.id) ? {
    ...record,
    tags: successful.get(record.id).tags,
    revertedAt: record.revertedAt || new Date().toISOString()
  } : record);
}

// Run snapshots can be hours old; tags must come from Eagle at write time or
// manual tags added after analysis would be overwritten.
export async function withLiveTags(items, api, options = {}) {
  if (!api?.itemInfo) {
    if (options.requireTags) throw new Error("写回必须读取 Eagle 当前标签");
    return { items, live: false };
  }
  const refreshed = [];
  for (const item of items) {
    const info = await api.itemInfo(item.id);
    if (options.requireTags && !Array.isArray(info?.tags)) {
      throw new Error(`无法读取文件的当前标签：${item.id}`);
    }
    refreshed.push({ ...item, tags: Array.isArray(info?.tags) ? info.tags : [], star: info?.star ?? 0 });
  }
  return { items: refreshed, live: true };
}

export async function applyWriteback(plan, api, options = {}) {
  if (options.apply !== true) {
    return {
      dryRun: true,
      summary: plan.summary,
      results: plan.items.map(item => ({ ...item }))
    };
  }

  const results = [];
  for (const item of plan.items) {
    if (!item.changed) {
      results.push({ ...item, ok: true, unchanged: true });
      continue;
    }
    try {
      await api.updateItem({ id: item.id, tags: item.tags, ...(item.star !== undefined ? { star: item.star } : {}) });
      results.push({ ...item, ok: true });
    } catch (error) {
      results.push({ ...item, ok: false, error: error.message });
    }
  }
  return { dryRun: false, summary: plan.summary, results };
}

export { ACTION_TAGS, FLAG_TAGS, AI_TAGS, CLEARABLE_TAGS };

// Keep the first successful pre-write snapshot across live and final writes.
// A completed revert starts a fresh cycle; user metadata remains read live.
export function mergeWritebackRecords(previous = [], incoming = []) {
  const merged = new Map(previous.map(record => [record.id, record]));
  for (const record of incoming) {
    const prior = merged.get(record.id);
    merged.set(record.id, prior && !prior.revertedAt ? { ...record,
      previousTags: prior.previousTags,
      ...(prior.live ? { live: true } : {}),
      ...(prior.previousStar !== undefined ? { previousStar: prior.previousStar, star: prior.star } : {})
    } : record);
  }
  return [...merged.values()];
}

export function addLiveStars(plan, items, enabled = false) {
  if (!enabled) return plan;
  const live = new Map(items.map(item => [item.id, item]));
  for (const row of plan.items) {
    const star = live.get(row.id)?.star ?? 0;
    if (row.action === 'selected' && star === 0) Object.assign(row, { star: 5, previousStar: 0, changed: true });
  }
  plan.changed = plan.items.filter(row => row.changed);
  plan.unchanged = plan.items.filter(row => !row.changed);
  plan.summary = summarizeWriteback(plan.items);
  return plan;
}
