function countTrash(result) {
  return Array.isArray(result.trash)
    ? result.trash.filter(item => item.ok !== false).length
    : result.trash?.ids?.length || 0;
}

export function formatApplyResult(result, { base = "", runId = "" } = {}) {
  const summary = result.summary || {};
  const rows = result.results || [];
  const failed = rows.filter(item => item.ok === false);
  const changed = summary.changed ?? rows.filter(item => item.changed).length;
  const unchanged = summary.unchanged ?? rows.filter(item => item.unchanged).length;
  const lines = [
    `已修改 ${changed} 项`,
    `未变化 ${unchanged} 项`,
    `失败 ${failed.length} 项`
  ];
  if (failed.length) {
    lines.push(...failed.slice(0, 10).map(item => `${item.fileName || item.name || item.id}：${item.error || "未知原因"}`));
  }
  const trashCount = countTrash(result);
  if (trashCount) lines.push(`移入回收站 ${trashCount} 项`);
  if (result.liveTags !== undefined) lines.push(`使用 Eagle 实时标签：${result.liveTags ? "是" : "否"}`);
  if (result.warning) lines.push(`提示：${result.warning}`);
  if (runId) {
    const prefix = base.replace(/\/$/, "");
    lines.push(`报告：CSV ${prefix}/runs/${runId}/report?format=csv`);
    lines.push(`报告：JSON ${prefix}/runs/${runId}/report?format=json`);
  }
  return lines.join("\n");
}

export function formatApplySummary(result, { base = "", runId = "" } = {}) {
  const summary = result.summary || {};
  const rows = result.results || [];
  const report = runId ? `${base.replace(/\/$/, "")}/runs/${runId}/report` : "";
  return {
    changed: summary.changed ?? rows.filter(item => item.changed).length,
    unchanged: summary.unchanged ?? rows.filter(item => item.unchanged).length,
    failed: summary.failed ?? rows.filter(item => item.ok === false).length,
    trash: countTrash(result),
    warning: result.warning || "",
    csvUrl: report ? `${report}?format=csv` : "",
    jsonUrl: report ? `${report}?format=json` : ""
  };
}
