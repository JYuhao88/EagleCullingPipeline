function countTrash(result) {
  return Array.isArray(result.trash)
    ? result.trash.filter(item => item.ok !== false).length
    : result.trash?.ids?.length || 0;
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
