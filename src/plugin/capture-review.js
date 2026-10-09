import { mergeReviewStateTags } from "./review-model.js";
import { buildCaptureIndex } from "./capture-units.js";

export function planCaptureReview(catalogue, decisions, { syncPairs = true } = {}) {
  const captures = buildCaptureIndex(catalogue);
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const planned = new Map();
  for (const decision of decisions) {
    mergeReviewStateTags([], decision.reviewState);
    if (!byId.has(decision.id)) throw new Error("审阅项目不在当前资源库目录中");
    const unit = captures.get(decision.id);
    const ids = syncPairs && unit.status === "paired" ? unit.itemIds : [decision.id];
    for (const id of ids) {
      const previous = planned.get(id);
      if (previous && previous.reviewState !== decision.reviewState) throw new Error("同一次拍摄不能获得相反的成对审阅结论");
      const item = byId.get(id);
      planned.set(id, { id, modifiedAt: item.modifiedAt ?? null, reviewState: decision.reviewState, initialTags: [...(item.tags || [])] });
    }
  }
  const entries = [];
  const included = new Set();
  for (const member of planned.values()) {
    if (included.has(member.id)) continue;
    const unit = captures.get(member.id);
    const ids = syncPairs && unit.status === "paired" ? unit.itemIds : [member.id];
    const members = ids.map((id) => planned.get(id));
    members.forEach((item) => included.add(item.id));
    entries.push({ id: member.id, modifiedAt: null, status: "pending", attempts: 0, result: { review: { members, appliedIds: [] } } });
  }
  return entries;
}

export async function applyReviewUnit(api, entry, { libraryPath, checkpoint = async () => {}, onApplied = () => {}, beforeWrite = () => {} } = {}) {
  const review = entry.result?.review;
  if (!review?.members?.length) throw new Error("审阅任务缺少成对计划");
  review.appliedIds ||= [];
  const pending = review.members.filter((member) => !review.appliedIds.includes(member.id));
  const read = async (ids) => typeof api.item.getByIds === "function" ? api.item.getByIds(ids) : Promise.all(ids.map((id) => api.item.getById(id)));
  if (api.library?.path !== libraryPath) throw new Error("资源库已切换，未写入标签");
  const items = await read(pending.map((member) => member.id));
  if (api.library?.path !== libraryPath) throw new Error("资源库已切换，未写入标签");
  const current = new Map(items.filter(Boolean).map((item) => [item.id, item]));
  // Validate all pending members before the first save. Already-applied members
  // survive partial failure/retry; official Item.save is not a multi-item transaction.
  for (const member of pending) {
    const item = current.get(member.id);
    if (!item) return { status: "skipped", error: "配对成员缺失，未继续写入" };
    const targetTags = mergeReviewStateTags(item.tags || [], member.reviewState);
    const alreadyTarget = JSON.stringify(targetTags) === JSON.stringify(item.tags || []);
    if (!alreadyTarget && member.modifiedAt != null && item.modifiedAt !== member.modifiedAt) return { status: "skipped", error: "配对成员已修改，保留人工变更" };
  }
  for (const member of pending) {
    // Re-read immediately before each write, not just before the first member.
    const item = await api.item.getById(member.id);
    if (api.library?.path !== libraryPath) throw new Error("资源库已切换，停止剩余成员写入");
    if (!item) return { status: "skipped", error: "成员在写入前消失，已完成的标签保留" };
    const tags = mergeReviewStateTags(item.tags || [], member.reviewState);
    if (JSON.stringify(tags) !== JSON.stringify(item.tags || [])) {
      if (member.modifiedAt != null && item.modifiedAt !== member.modifiedAt) return { status: "skipped", error: "成员在写入前已修改，保留人工变更" };
      beforeWrite();
      item.tags = tags;
      if (await item.save() === false) throw new Error("Eagle 拒绝标签写入");
    }
    review.appliedIds.push(member.id);
    onApplied(item);
    try { await checkpoint(entry); }
    catch (error) { error.fatal = true; throw error; }
  }
  return { status: "succeeded" };
}
