// Pure presentation rules; selection and analysis semantics stay in the existing APIs.
export function primaryAnalysis(context = {}, connected = true, busy = false) {
  const selected = context.itemIds?.length || 0;
  const count = context.folderCount ?? context.folderItemIds?.length ?? 0;
  const folder = context.folders?.length > 0;
  return {
    label: selected ? `分析选中的 ${selected} 张` : folder ? `分析当前文件夹（${count} 张）` : "开始分析",
    disabled: !connected || busy || (!selected && (!folder || !count)),
    hint: selected ? "只分析选中的照片。" : folder ? count ? "分析当前文件夹中的照片。" : "这个文件夹没有照片，请换一个。"
      : "请先在 Eagle 左侧选择文件夹，或选中几张照片。",
    itemIds: selected ? context.itemIds : context.folderItemIds || []
  };
}

import { progressEstimate } from "./service-start.js";

export const analysisStages = [
  "扫描", "画质分析", "特征提取", "人脸分析", "姿态分析", "对焦分析", "分组", "排序", "完成"
];
export function stageIndex(stage) {
  if (["scanning", "pairing"].includes(stage)) return 0;
  return { metrics: 1, embedding: 2, faces: 3, pose: 4, focus: 5, grouping: 6, ranking: 7, done: 8 }[stage] ?? 0;
}

export function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "未记录";
  const total = Math.ceil(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60), remainder = total % 60;
  if (minutes < 60) return `${minutes} 分 ${remainder} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function analysisProgress(run, now = Date.now()) {
  const progress = run.progress || {};
  const active = ["running", "queued"].includes(run.status);
  const overallPercent = run.status === "completed" ? 100 : Number.isFinite(progress.overallPercent)
    ? Math.max(0, Math.min(100, progress.overallPercent)) : null;
  let elapsedSeconds = progress.elapsedSeconds;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    const start = Date.parse(run.startedAt || "");
    elapsedSeconds = active && Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null;
  }
  const remainingSeconds = active ? progressEstimate(run) : run.status === "completed" ? 0 : null;
  const stage = run.status === "completed" ? "完成" : run.status === "queued" ? "等待分析"
    : progress.stage ? analysisStages[stageIndex(progress.stage)] : "准备分析";
  const remaining = remainingSeconds === null ? active ? "估算中…" : "未记录" : durationText(remainingSeconds);
  const percentage = overallPercent === null ? "总体进度待估算" : `总体 ${Math.floor(overallPercent)}%`;
  return { overallPercent, elapsedSeconds, remainingSeconds, stage,
    text: `${stage} · ${percentage} · 已用 ${durationText(elapsedSeconds)} · 预计剩余 ${remaining}` };
}

export function readRecentRuns(storage) {
  try {
    const value = JSON.parse(storage.getItem("eagle-culling-recent-runs") || "[]");
    return Array.isArray(value) ? value.filter(id => typeof id === "string" && /^[\w-]+$/.test(id)).slice(0, 10) : [];
  } catch { return []; }
}
