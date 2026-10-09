const TYPES = {
  "analyze-selection":"照片分析",
  "review-units":"人工审阅（同步配对）",
  "restore-thumbnails":"恢复原生缩略图",
  "restore-thumbnail-backups":"恢复登记的缩略图备份",
  "badge-thumbnails-selection":"生成所选照片网格角标",
  "badge-thumbnails-library":"生成全库网格角标",
};
const STATES = {
  uploading:"计划上传中",pending:"等待执行",running:"执行中",
  succeeded:"已完成",skipped:"已跳过",failed:"失败，待处理",
  paused:"已暂停",cancelled:"已取消",
};
export function taskLabels(task) {
  return {
    type:TYPES[task.taskType] || `未知任务（${task.taskType || "未提供类型"}）`,
    status:task.activationPending && task.status === "paused" ? "待确认启动" : STATES[task.status] || `未知状态（${task.status || "未提供状态"}）`,
  };
}
