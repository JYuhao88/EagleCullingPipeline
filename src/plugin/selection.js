export function rankedUnitIds(group) {
  if (group?.presentationOrder?.length === group.unitIds?.length) return [...group.presentationOrder];
  const ranks = new Map((group?.ranking || []).map(item => [item.unitId, item.rank ?? Infinity]));
  return [...(group?.unitIds || [])].sort((left, right) => (ranks.get(left) ?? Infinity) - (ranks.get(right) ?? Infinity));
}

export function toggleSelection(selected, unitId, { range = false, orderedIds = [] } = {}) {
  const current = new Set(selected || []);
  if (range && orderedIds.length) {
    const selectedIds = [...current];
    const anchor = selectedIds.at(-1) || unitId;
    const start = orderedIds.indexOf(anchor);
    const end = orderedIds.indexOf(unitId);
    if (start >= 0 && end >= 0) {
      const [from, to] = start < end ? [start, end] : [end, start];
      for (const id of orderedIds.slice(from, to + 1)) current.add(id);
      return [...current];
    }
  }
  if (current.has(unitId)) current.delete(unitId);
  else current.add(unitId);
  return [...current];
}

export function selectionTargets(selected, focusedId) {
  return selected?.length ? [...selected] : (focusedId ? [focusedId] : []);
}

export function batchDecisions(unitIds, action, metadata = {}) {
  return unitIds.map(unitId => ({ unitId, action, flags: [], source: "human", ...metadata }));
}

export function groupStatus(group, decisions) {
  const human = new Set((decisions || []).filter(item => item.source === "human").map(item => item.unitId));
  return (group?.unitIds || []).every(unitId => human.has(unitId)) ? "已审" : "未审";
}

export function groupIssues(group, results) {
  const wanted = new Set();
  for (const unitId of group?.unitIds || []) {
    for (const flag of results?.find(item => item.unitId === unitId)?.flags || []) wanted.add(flag);
  }
  return [...wanted];
}
