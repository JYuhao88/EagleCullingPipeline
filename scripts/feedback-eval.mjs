import path from "node:path";
import { readFile } from "node:fs/promises";
import { FeedbackStore, feedbackStats } from "../src/server/feedback-store.js";
import { feedbackCatalog } from "../src/server/feedback-routes.js";

const input = process.argv[2] || "data/feedback";
const events = input.endsWith(".jsonl")
  ? (await readFile(path.resolve(input), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  : await new FeedbackStore(input).read();
const stats = feedbackStats(events, (await feedbackCatalog()).reasons);
if (!stats.activeEvents) console.log("暂无有效反馈数据，无法计算误删代理率、理由一致率和改选首选比例。");
else {
  const show = metric => metric.rate === null ? "无可评估数据" : `${(100 * metric.rate).toFixed(2)}% (${metric.numerator}/${metric.denominator})`;
  console.log(`有效反馈：${stats.activeEvents} 条（原始 ${stats.totalEvents} 条，撤销 ${stats.undoEvents} 条）`);
  console.log(`误删代理率：${show(stats.falseRejectProxy)}`);
  console.log(`工具保留而用户淘汰：${show(stats.keepRejectedProxy)}`);
  console.log(`理由与工具 verdict 一致率：${show(stats.reasonVerdictAgreement)}`);
  console.log(`改选首选比例：${show(stats.winnerChangeRatio)}`);
}
