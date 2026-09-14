import { readFile } from "node:fs/promises";
import { writeInventoryAtomic } from "./inventory.js";

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export async function buildBenchmark(analysis, size = 300) {
  const all = analysis.items || [];
  const byId = new Map(all.map((item) => [item.id, item]));
  const selected = [];
  const seen = new Set();
  // Include every multi-member group's members first: these are the most
  // informative examples for duplicate and representative selection tests.
  for (const group of analysis.groups || []) {
    if (group.size < 2) continue;
    for (const member of group.items) {
      if (selected.length >= size) break;
      selected.push(member.id); seen.add(member.id);
    }
    if (selected.length >= size) break;
  }
  const remaining = all.filter((item) => !seen.has(item.id))
    .sort((a, b) => hashSeed(a.id) - hashSeed(b.id));
  for (const item of remaining) {
    if (selected.length >= size) break;
    selected.push(item.id);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: analysis.generatedAt,
    instructions: "人工填写 labels.duplicateGroup, labels.preferred, labels.blur, labels.closedEyes, labels.exposureIssue, labels.keep.",
    items: selected.map((id, index) => ({
      index: index + 1,
      id,
      name: byId.get(id)?.name,
      filePath: byId.get(id)?.filePath,
      labels: {},
    })),
  };
}

export async function writeBenchmark(analysisPath, outputPath, size) {
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  const benchmark = await buildBenchmark(analysis, size);
  await writeInventoryAtomic(benchmark, outputPath);
  return benchmark;
}

