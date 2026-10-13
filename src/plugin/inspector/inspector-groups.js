// Run-wide context for the inspector, computed from the run queue (one row per photo unit).
export function runGroups(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.groupId ?? row.unitId;
    if (!groups.has(key)) groups.set(key, { groupId: key, groupIndex: row.groupIndex ?? groups.size,
      confidence: row.confidence || null, units: [] });
    groups.get(key).units.push(row);
  }
  return [...groups.values()].sort((a, b) => a.groupIndex - b.groupIndex).map(group => {
    const units = group.units.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const decided = units.filter(unit => unit.human).length;
    return { ...group, units, best: units[0], decided, done: decided === units.length };
  });
}

export function runProgress(rows = []) {
  const count = action => rows.filter(row => row.human === action).length;
  const decided = rows.filter(row => row.human).length;
  return { total: rows.length, decided, selected: count('selected'), candidate: count('candidate'),
    rejected: count('rejected'), done: rows.length > 0 && decided === rows.length };
}

const unitItems = unit => unit?.itemIds?.length ? unit.itemIds : [unit?.primaryItemId].filter(Boolean);
export { unitItems };

// Where a navigation button goes from the current group, and which photo to select there.
// prev/next stop at the ends; undecided/uncertain search forward and wrap, never landing on the current group.
export function groupTarget(groups, currentId, mode) {
  const position = groups.findIndex(group => group.groupId === currentId);
  if (mode === 'prev' || mode === 'next') {
    const group = groups[position + (mode === 'prev' ? -1 : 1)];
    return group && position >= 0 ? { group, unit: group.best } : null;
  }
  const wanted = mode === 'undecided' ? group => !group.done
    : group => group.confidence === 'low' && !group.done;
  for (let step = 1; step <= groups.length; step++) {
    const group = groups[(Math.max(position, -1) + step + groups.length) % groups.length];
    if (group.groupId === currentId) continue;
    if (wanted(group)) return { group, unit: mode === 'undecided' ? group.units.find(unit => !unit.human) : group.best };
  }
  return null;
}

export function neighbourGroups(groups, currentId) {
  const position = groups.findIndex(group => group.groupId === currentId);
  if (position < 0) return [];
  return [['prev', groups[position - 1]], ['next', groups[position + 1]]].filter(([, group]) => group)
    .map(([side, group]) => ({ side, group }));
}

// The analysis of the selected photo carries fresh decisions for its group; fold them into the cached queue.
export function patchRows(rows, members = []) {
  if (!members.length) return rows;
  const human = new Map(members.map(member => [member.unitId, member.human || null]));
  let changed = false;
  const next = rows.map(row => {
    if (!human.has(row.unitId) || (row.human || null) === human.get(row.unitId)) return row;
    changed = true;
    return { ...row, human: human.get(row.unitId), action: human.get(row.unitId) || row.suggested };
  });
  return changed ? next : rows;
}

// Multi-select summary: how many photo units are selected and which groups they belong to.
export function selectionSummary(rows, selectedIds) {
  const owners = new Map(rows.flatMap(row => unitItems(row).map(id => [id, row])));
  const units = new Map();
  let unknown = 0;
  for (const id of selectedIds) {
    const row = owners.get(id);
    if (row) units.set(row.unitId, row); else unknown++;
  }
  const groupIds = new Set([...units.values()].map(row => row.groupId));
  return { units: [...units.values()], groupCount: groupIds.size, unknown,
    groupIndex: groupIds.size === 1 ? [...units.values()][0].groupIndex : null };
}
