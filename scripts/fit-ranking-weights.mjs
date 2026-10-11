import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { personalizeReport } from "../src/core/personalize.js";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

async function main() {
  const runId = arg("--run") || process.argv[2];
  const labelsPath = arg("--labels");
  if (!runId || !labelsPath) throw new Error("用法：--run <runId> --labels <spot-check.json> [--write]");
  const root = path.resolve("data", "runs", runId);
  const resultsData = JSON.parse(await readFile(path.join(root, "results.json"), "utf8"));
  const labelsData = JSON.parse(await readFile(path.resolve(labelsPath), "utf8"));
  if (labelsData.runId && labelsData.runId !== runId) throw new Error(`标注 runId=${labelsData.runId} 与参数不一致`);
  const labels = labelsData.labels || labelsData;
  const report = personalizeReport(resultsData, labels.filter(label => label.bestUnitId != null).map(label => ({
    unitId: label.bestUnitId, action: 'selected', source: 'human', updatedAt: label.updatedAt
  })));
  const weightsPath = path.resolve("src/core/ranking-weights.json");
  const currentConfig = JSON.parse(await readFile(weightsPath, "utf8"));
  const fittedWeights = report.weights;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready || !process.argv.includes('--write')) {
    console.log('未写入：需要独立留出集的 bootstrap 提升区间大于零，并显式 --write。');
    return;
  }
  const next = {
    ...currentConfig,
    version: `${Number.parseInt(currentConfig.version, 10) + 1 || 2}.0`,
    source: `spot-check-${runId}`,
    weights: { ...currentConfig.weights, ...fittedWeights, aesthetic: 0 },
  };
  await writeFile(weightsPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`已写入 ${weightsPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
