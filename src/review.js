import { readFile } from "node:fs/promises";

const ACTION_TAGS = {
  original: "ai:original",
  candidate: "ai:candidate",
  selected: "ai:selected",
  rejected: "ai:rejected",
};
const QUALITY_TAGS = new Set([
  "ai:eyes-closed",
  "ai:possibly-blurry",
  "ai:overexposed",
  "ai:underexposed",
  "ai:low-resolution",
]);

export async function loadReview(filePath) {
  const review = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(review.decisions)) throw new Error("Review file must contain a decisions array");
  return review;
}

export function buildUpdate(decision, current = {}, folderMap = {}, { includeStar = true } = {}) {
  const action = decision.action;
  if (!ACTION_TAGS[action]) throw new Error(`Unsupported review action: ${action}`);
  const existing = Array.isArray(current.tags) ? current.tags : [];
  const tags = existing.filter((tag) => !Object.values(ACTION_TAGS).includes(tag) && !QUALITY_TAGS.has(tag));
  tags.push(ACTION_TAGS[action]);
  for (const flag of Array.isArray(decision.flags) ? decision.flags : []) {
    if (/^[a-z0-9-]+$/i.test(flag)) tags.push(`ai:${flag}`);
  }
  const uniqueTags = [...new Set(tags)];
  const update = { id: decision.id, tags: uniqueTags };
  const folderId = decision.folderId || folderMap[action];
  if (folderId) update.folders = [...new Set([...(current.folders || []), folderId])];
  if (includeStar && Number.isInteger(decision.star)) update.star = Math.max(0, Math.min(5, decision.star));
  if (decision.annotation) update.annotation = decision.annotation;
  return update;
}

export async function applyReview(api, review, { apply = false, lookup = new Map(), folderMap = {}, includeStar = true, onUpdate = () => {} } = {}) {
  const plan = review.decisions.map((decision) => buildUpdate(decision, lookup.get(decision.id), folderMap, { includeStar }));
  if (!apply) return { applied: false, plan };
  const results = [];
  for (const update of plan) {
    results.push(await api.updateItem(update));
    onUpdate(update);
  }
  return { applied: true, plan, results };
}

export { ACTION_TAGS };
