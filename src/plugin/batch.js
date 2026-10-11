import { batchDecisions } from "./selection.js";

export function highConfidenceGroups(groups, decisions = []) {
  const human = new Set(decisions.filter(item => item.source === "human").map(item => item.unitId));
  return (groups || []).filter(group => group.confidence === "high" && !group.unitIds.some(id => human.has(id)));
}

export function labeledGroupCount(groups, decisions = []) {
  const selected = new Set(decisions.filter(item => item.source === "human" && item.action === "selected")
    .map(item => item.unitId));
  return (groups || []).filter(group => group.unitIds.length > 1
    && group.unitIds.filter(id => selected.has(id)).length === 1).length;
}

export function decisionRequests(unitIds, action, metadata) {
  return batchDecisions(unitIds, action, metadata);
}

export function undoRequests(previous, current) {
  const currentById = new Map((current || []).map(item => [item.unitId, item]));
  return (previous || []).map(item => item.decision
    ? item.decision
    : { unitId: item.unitId, clear: true, previous: currentById.get(item.unitId) || null });
}

export function issueUnitIds(groups, results, issue, decisions = []) {
  const resultById = new Map((results || []).map(item => [item.unitId, item]));
  const human = new Set((decisions || []).filter(item => item.source === "human").map(item => item.unitId));
  return (groups || []).flatMap(group => group.unitIds || [])
    .filter(unitId => !human.has(unitId))
    .filter(unitId => (resultById.get(unitId)?.flags || []).includes(issue));
}

export function unreviewedSuggestions(groups, decisions = []) {
  const human = new Set(decisions.filter(item => item.source === "human").map(item => item.unitId));
  return groups.flatMap(group => group.unitIds.filter(unitId => !human.has(unitId)).map(unitId => ({
    unitId, action: group.suggested?.[unitId] || "candidate", flags: [], source: "human"
  })));
}
