import { readFile } from "node:fs/promises";
import { writeInventoryAtomic } from "./inventory.js";

export async function buildRecommendations(analysis) {
  const decisions = [];
  for (const group of analysis.groups || []) {
    const ranked = [...group.items].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
    ranked.forEach((item, index) => {
      const action = group.size > 1 ? (index === 0 ? "selected" : "rejected") : "candidate";
      decisions.push({
        id: item.id,
        action,
        star: action === "selected" ? 5 : action === "candidate" ? 3 : 1,
        reason: `${group.size > 1 ? `phash group ${group.groupId}; rank ${index + 1}/${group.size}` : "singleton; needs review"}${item.qualityFlags?.length ? `; flags: ${item.qualityFlags.join(",")}` : ""}`,
      });
    });
  }
  return { schemaVersion: 1, sourceGeneratedAt: analysis.generatedAt, generatedAt: new Date().toISOString(), decisions };
}

export async function writeRecommendations(analysisPath, outputPath) {
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  const review = await buildRecommendations(analysis);
  await writeInventoryAtomic(review, outputPath);
  return review;
}
