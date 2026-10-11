import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreLabels } from "../src/core/spot-eval.js";

export { scoreLabels };

async function main() {
  const runIndex = process.argv.indexOf("--run");
  const labelsIndex = process.argv.indexOf("--labels");
  if (runIndex < 0 || labelsIndex < 0) throw new Error("用法：--run <runId> --labels <file>");
  const runId = process.argv[runIndex + 1];
  const labelsPath = path.resolve(process.argv[labelsIndex + 1]);
  const root = path.resolve("data", "runs", runId);
  const data = JSON.parse(await readFile(path.join(root, "results.json"), "utf8"));
  const labels = JSON.parse(await readFile(labelsPath, "utf8"));
  const report = scoreLabels(data, labels.labels || labels);
  console.log(JSON.stringify(report, null, 2));
  const pct = (value) => (value == null ? "无数据" : `${(value * 100).toFixed(1)}%`);
  console.log(`中文摘要：模型 top-1 与人工选择一致率 ${pct(report.top1.rate)}；组内两两一致率 ${pct(report.pairwise.rate)}。`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
