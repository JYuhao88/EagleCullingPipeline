import { rankGroup, suggestDecision } from "./ranking.js";
import { buildCandidateSet } from "./candidates.js";

function requireGroup(groups, id) {
  const group = groups.find(value => value.id === id);
  if (!group) throw new Error(`找不到组：${id}`);
  return group;
}

function rerank(group, results) {
  const items = group.unitIds.map(id => {
    const result = results.find(value => (value.unitId || value.id) === id);
    if (!result) throw new Error(`找不到分析结果：${id}`);
    return result;
  });
  const ranking = rankGroup(items);
  const decisions = ranking.map(entry => {
    const item = items.find(value => (value.unitId || value.id) === entry.unitId);
    return [entry.unitId, suggestDecision(entry, item, items.length)];
  });
  if (items.length > 1 && !decisions.some(([, action]) => action === "selected")) {
    const fallback = decisions.findIndex(([, action]) => action !== "rejected");
    if (fallback >= 0) decisions[fallback][1] = "selected";
  }
  const revised = { ...group, unitIds: [...group.unitIds], ranking,
    suggested: Object.fromEntries(decisions), candidateSet: buildCandidateSet(items) };
  delete revised.averageSimilarity;
  if ("items" in group) revised.items = items;
  if ("size" in group) revised.size = items.length;
  return revised;
}

export function applyGroupOverrides(groups, results, operations = []) {
  let revised = groups.map(group => ({ ...group, unitIds: [...group.unitIds] }));
  for (const operation of operations) {
    const affected = new Set();
    if (operation.type === "move") {
      const source = revised.find(group => group.unitIds.includes(operation.unitId));
      if (!source) throw new Error(`找不到照片单元：${operation.unitId}`);
      const target = operation.targetGroupId === "new"
        ? createGroup(revised, operation.newGroupId, revised.indexOf(source) + 1)
        : requireGroup(revised, operation.targetGroupId);
      if (target === source) throw new Error("照片已经在目标组中");
      source.unitIds = source.unitIds.filter(id => id !== operation.unitId);
      target.unitIds.push(operation.unitId);
      affected.add(source.id);
      affected.add(target.id);
    } else if (operation.type === "split") {
      const source = requireGroup(revised, operation.groupId);
      const ids = operation.unitIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.length >= source.unitIds.length) {
        throw new Error("拆分需要选择组内部分照片，且不能重复");
      }
      if (!ids.every(id => source.unitIds.includes(id))) throw new Error("所选照片不属于该组");
      const target = createGroup(revised, operation.newGroupId, revised.indexOf(source) + 1);
      target.unitIds = [...ids];
      source.unitIds = source.unitIds.filter(id => !ids.includes(id));
      affected.add(source.id);
      affected.add(target.id);
    } else if (operation.type === "merge") {
      const ids = operation.groupIds;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length < 2) {
        throw new Error("合并需要至少两个不同的组");
      }
      const selected = ids.map(id => requireGroup(revised, id));
      const target = selected[0];
      target.unitIds = selected.flatMap(group => group.unitIds);
      revised = revised.filter(group => !ids.includes(group.id) || group.id === target.id);
      affected.add(target.id);
    } else {
      throw new Error(`未知分组修正：${operation.type}`);
    }
    revised = revised.filter(group => group.unitIds.length)
      .map(group => affected.has(group.id) ? rerank(group, results) : group);
  }
  return revised;
}

function createGroup(groups, id, index) {
  if (!id || groups.some(group => group.id === id)) throw new Error("新组标识缺失或重复");
  const group = { contractVersion: 1, id, unitIds: [] };
  groups.splice(index, 0, group);
  return group;
}
