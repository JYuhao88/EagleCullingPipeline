const LABELS = {pending:"待处理",running:"处理中",succeeded:"成功",skipped:"跳过",failed:"失败",paused:"暂停",cancelled:"取消"};

export function buildTaskReport(task, snapshotAt = new Date().toISOString()) {
  if (!Array.isArray(task?.items)) throw new Error("缺少完整任务明细，不能用摘要生成验收报告");
  const counts = {total:task.items.length,succeeded:0,skipped:0,failed:0,pending:0,running:0,paused:0,cancelled:0,unknown:0};
  const files = new Set();
  const appliedFiles = new Set();
  const units = task.items.map(entry=>{
    const review = entry.result?.review;
    const members = review?.members || entry.result?.analysisPlan?.members || entry.result?.captureResults || [{id:entry.id}];
    const affectedItemIds = [...new Set(members.map(member=>member.id).filter(Boolean))];
    affectedItemIds.forEach(id=>files.add(id));
    const confirmedAppliedIds = (review?.appliedIds || []).filter(id=>affectedItemIds.includes(id));
    confirmedAppliedIds.forEach(id=>appliedFiles.add(id));
    const status = entry.status || "pending";
    counts[Object.hasOwn(LABELS,status) ? status : "unknown"]++;
    return {unitId:entry.id,name:entry.result?.name || "",status,statusLabel:LABELS[status] || "未知",attempts:entry.attempts || 0,
      affectedItemIds,confirmedAppliedIds,sourceId:entry.result?.analysisPlan?.sourceId || entry.result?.analysisSourceId || null,
      error:entry.error || null,modifiedAt:entry.modifiedAt ?? null,updatedAt:entry.updatedAt || null};
  });
  const processed = counts.succeeded + counts.skipped + counts.failed;
  return {schemaVersion:1,taskId:task.taskId,taskType:task.taskType,status:task.status,libraryPath:task.libraryPath,
    manifestVersion:task.manifestVersion,createdAt:task.createdAt,taskUpdatedAt:task.updatedAt,snapshotAt,
    counts:{...counts,affectedFiles:files.size,confirmedReviewAppliedFiles:appliedFiles.size,
      processingCompletionPercent:counts.total ? Math.round(processed/counts.total*10000)/100 : 0,
      successPercent:counts.total ? Math.round(counts.succeeded/counts.total*10000)/100 : 0},
    caveats:["这是任务断点快照，不是原片 SHA 或实际预览效果的验收证明。",
      "处理结束比例包括成功、跳过、失败；100% 不表示全部成功。",
      "任务数量按分析/操作单元统计；成对成员数量单独列出。",
      "成对标签部分写入只将已登记 appliedIds 列为确认应用；其余成员的具体结果未确认。"],units};
}

function csvCell(value) {
  let text = String(value ?? "");
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"','""')}"`;
}

export function taskExceptionsCsv(report) {
  const header = ["任务ID","资源库","任务状态","快照时间","任务单元ID","名称","单元状态","重试次数","涉及文件ID","已确认标签应用ID","分析来源ID","原因"];
  const rows = report.units.filter(unit=>unit.status !== "succeeded" || unit.error).map(unit=>[
    report.taskId,report.libraryPath,LABELS[report.status] || report.status,report.snapshotAt,unit.unitId,unit.name,unit.statusLabel,
    unit.attempts,unit.affectedItemIds.join(";"),unit.confirmedAppliedIds.join(";"),unit.sourceId,unit.error]);
  return "\ufeff" + [header,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
