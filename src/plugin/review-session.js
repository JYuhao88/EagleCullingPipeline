const prefix = "eagle-culling-session:";

function storageOf(storage) { return storage || globalThis.localStorage; }

export function restore(runId, storage) {
  if (!runId) return null;
  try {
    const value = JSON.parse(storageOf(storage)?.getItem(`${prefix}${runId}`) || "null");
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

export function save(runId, patch, storage) {
  if (!runId) return null;
  const target = storageOf(storage);
  if (!target) return patch;
  const next = { ...(restore(runId, target) || {}), ...patch, savedAt: new Date().toISOString() };
  try { target.setItem(`${prefix}${runId}`, JSON.stringify(next)); } catch { /* private browsing */ }
  return next;
}

export function nearestUndecided(ids = [], decisions = [], rememberedId = null) {
  const human = new Set((decisions || []).filter(row => row.source === "human").map(row => row.unitId));
  if (rememberedId && ids.includes(rememberedId) && !human.has(rememberedId)) return rememberedId;
  const index = rememberedId ? Math.max(0, ids.indexOf(rememberedId)) : 0;
  return ids.slice(index).find(id => !human.has(id)) || ids.find(id => !human.has(id)) || ids[0] || null;
}

export function restoreWithFallback(runId, { ids = [], decisions = [], storage } = {}) {
  const remembered = restore(runId, storage) || {};
  const unitId = nearestUndecided(ids, decisions, remembered.unitId);
  return { ...remembered, unitId, unitIndex: Math.max(0, ids.indexOf(unitId)) };
}

export const reviewSession = { restore, save, nearestUndecided, restoreWithFallback };
