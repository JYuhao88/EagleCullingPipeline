import { readFile } from "node:fs/promises";

const ACTION_TAGS = {
  original: "ai:original",
  candidate: "ai:candidate",
  selected: "ai:selected",
  rejected: "ai:rejected",
};

export async function loadReview(filePath) {
  const review = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(review.decisions)) throw new Error("Review file must contain a decisions array");
  return review;
}

export function buildUpdate(decision, current = {}, folderMap = {}) {
  const action = decision.action;
  if (!ACTION_TAGS[action]) throw new Error(`Unsupported review action: ${action}`);
  const existing = Array.isArray(current.tags) ? current.tags : [];
  const tags = existing.filter((tag) => !Object.values(ACTION_TAGS).includes(tag));
  tags.push(ACTION_TAGS[action]);
  const update = { id: decision.id, tags };
  const folderId = decision.folderId || folderMap[action];
  if (folderId) update.folders = [...new Set([...(current.folders || []), folderId])];
  if (Number.isInteger(decision.star)) update.star = Math.max(0, Math.min(5, decision.star));
  if (decision.annotation) update.annotation = decision.annotation;
  return update;
}

export async function applyReview(api, review, { apply = false, lookup = new Map(), folderMap = {}, onUpdate = () => {} } = {}) {
  const plan = review.decisions.map((decision) => buildUpdate(decision, lookup.get(decision.id), folderMap));
  if (!apply) return { applied: false, plan };
  const results = [];
  for (const update of plan) {
    results.push(await api.updateItem(update));
    onUpdate(update);
  }
  return { applied: true, plan, results };
}

export { ACTION_TAGS };
