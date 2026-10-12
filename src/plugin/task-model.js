// Pure presentation rules for tasks ("the culling work for one scope"); see docs/ux-design.md.
import { analysisProgress, durationText } from "./start-model.js";

const BROKEN = ["failed", "cancelled", "interrupted"];

export function taskState(run = {}) {
  if (["running", "queued"].includes(run.status)) return "analyzing";
  if (BROKEN.includes(run.status)) return run.resumable === false || run.rerunnable === false ? "lost" : run.status;
  if (run.status !== "completed") return "lost";
  if (!run.groupCount) return "empty";
  if (run.reviewedGroupCount != null && run.reviewedGroupCount < run.groupCount) return "reviewing";
  if (run.pendingWriteback) return "pendingWriteback";
  if (run.writtenBackAt) return "writtenBack";
  return "toWriteback";
}

const URGENCY = ["analyzing", "reviewing", "interrupted", "cancelled", "toWriteback", "pendingWriteback", "failed", "lost",
  "writtenBack", "empty"];

export function sortTasks(runs = []) {
  return [...runs].sort((a, b) => URGENCY.indexOf(taskState(a)) - URGENCY.indexOf(taskState(b)) ||
    (Date.parse(b.lastDecisionAt || b.startedAt || 0) || 0) - (Date.parse(a.lastDecisionAt || a.startedAt || 0) || 0));
}

export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "时间未记录";
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

function percent(run) {
  const pct = Number(run.progress?.overallPercent);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.floor(pct))) : null;
}

export function friendlyFailure(message = "") {
  if (/EPERM|EBUSY|EACCES|rename/i.test(message)) return "文件被其他程序占用，暂时无法保存。稍后重试即可，已完成的部分会复用。";
  if (/ENOSPC|disk|空间/i.test(message)) return "磁盘空间不足。清理缓存或磁盘后重试。";
  if (/fetch|network|timeout|Failed to fetch/i.test(message)) return "与分析服务的连接中断。重试即可，已完成的部分会复用。";
  return "分析没有完成。重试即可，已完成的部分会复用；反复失败请在设置 › 高级中查看诊断。";
}

// Each task exposes exactly one primary action; secondary actions never compete visually.
export function taskView(run = {}, now = Date.now()) {
  const state = taskState(run);
  const groups = run.groupCount || 0, reviewed = run.reviewedGroupCount ?? 0;
  const left = Math.max(0, groups - reviewed);
  const meta = [`${run.itemCount || 0} 张`, groups ? `${groups} 组` : null, relativeTime(run.lastDecisionAt || run.startedAt, now)]
    .filter(Boolean).join(" · ");
  const pct = percent(run);
  const views = {
    analyzing: { chip: "分析中", detail: analysisProgress(run, now).text, progress: pct, primary: ["进度", "watch"] },
    interrupted: { chip: "已中断", detail: `分析在${pct === null ? "中途" : ` ${pct}%`}中断（服务重启或电脑睡眠），已完成的部分会复用。`,
      progress: pct, primary: ["继续分析", "resume"] },
    cancelled: { chip: "已暂停", detail: `已暂停${pct === null ? "" : `在 ${pct}%`}，继续时复用已完成的部分。`, progress: pct,
      primary: ["继续分析", "resume"] },
    failed: { chip: "失败", detail: friendlyFailure(run.error), progress: null, primary: ["重试", "resume"] },
    lost: { chip: "无法继续", detail: run.rerunnable ? "这条记录无法从中断处继续。按原范围重新分析，已做的决定会带上。"
      : "找不到原来的照片范围。请在 Eagle 重新选择这批照片再分析，已做的决定会自动带上。",
    progress: null, primary: run.rerunnable ? ["重新分析", "rerun"] : ["怎么做", "reselect"] },
    reviewing: { chip: `待挑选 ${reviewed}/${groups}`, detail: reviewed ? `还剩 ${left} 组` : `${groups} 组待挑选`,
      progress: groups ? Math.round(reviewed / groups * 100) : 0, primary: [reviewed ? "继续挑选" : "开始挑选", "review"] },
    toWriteback: { chip: "待写回", detail: "已挑完，尚未写回 Eagle。", progress: 100, primary: ["写回 Eagle", "finish"] },
    pendingWriteback: { chip: "有改动未写回", detail: `写回后又改过（上次写回 ${relativeTime(run.writtenBackAt, now)}）。`,
      progress: 100, primary: ["再次写回", "finish"] },
    writtenBack: { chip: "已写回", detail: `已写回 Eagle（${relativeTime(run.writtenBackAt, now)}）。`, progress: null,
      primary: ["打开", "review"] },
    empty: { chip: "没有照片", detail: "这次分析没有找到可挑选的照片。", progress: null, primary: ["打开", "review"] },
  };
  const view = views[state];
  const inherited = run.inheritedCount ? `，${run.inheritedCount} 张沿用之前的决定` : "";
  return { state, title: run.scope?.label || "以前的分析", meta, chip: view.chip, detail: view.detail + (state === "reviewing" ? inherited : ""),
    progress: view.progress, primary: { label: view.primary[0], action: view.primary[1] } };
}

export function needsAttention(run) {
  return ["reviewing", "interrupted", "cancelled", "failed", "toWriteback", "pendingWriteback"].includes(taskState(run));
}

export function selectionCount(context = {}) {
  const selected = context.selectionCount ?? context.itemIds?.length ?? 0;
  return selected || (context.folders?.length ? context.folderCount ?? context.folderItemIds?.length ?? 0 : 0);
}

export function scopeName(context = {}) {
  const selected = context.selectionCount ?? context.itemIds?.length ?? 0;
  if (selected) return `选中的 ${selected} 张`;
  if (context.folders?.length) return `文件夹「${context.folders.map(folder => folder.name || "未命名").join("、")}」`;
  return "";
}

// The main home card: one decision, derived from service state, Eagle's current selection and existing tasks.
export function homeCard({ connected = false, launching = false, active = null, context = {}, match = null,
  tasks = [], submitting = false, secondsPerPhoto = null, now = Date.now() } = {}) {
  if (!connected) {
    return launching ? { kind: "service", eyebrow: "分析服务", title: "正在启动分析服务…", detail: "首次启动可能需要十几秒。", action: null }
      : { kind: "service", eyebrow: "分析服务", title: "分析服务没有运行", detail: "挑片需要本机分析服务。启动后会自动连接。",
        action: { label: "启动服务", action: "startService" } };
  }
  if (active) {
    return { kind: "progress", eyebrow: "正在分析", title: active.scope?.label || "分析中", detail: analysisProgress(active, now).text,
      progress: percent(active), action: null, secondary: [{ label: "取消", action: "cancel" }],
      note: "可以关闭窗口，完成后会通知你。" };
  }
  const count = selectionCount(context), name = scopeName(context);
  if (count) {
    const task = match?.run;
    if (task && match.missing === 0) {
      const view = taskView(task, now);
      return { kind: "task", eyebrow: name, title: `已在任务「${view.title}」中`, detail: view.detail, task,
        action: { label: view.primary.label, action: view.primary.action }, progress: view.progress, chip: view.chip };
    }
    if (task && match.matched > 0) {
      const extra = match.missing;
      return { kind: "append", eyebrow: name, title: match.sameScope ? `「${taskView(task).title}」新增 ${extra} 张`
        : `${extra} 张是新照片，${match.matched} 张已在「${taskView(task).title}」中`,
      detail: "已分析过的照片直接复用，已做的决定会带到新结果里。", task,
      action: { label: `补充分析（新增 ${extra} 张）`, action: "analyze", disabled: submitting },
      secondary: [{ label: "先挑已分析的", action: "openMatch" }] };
    }
    const estimate = secondsPerPhoto ? `预计约 ${durationText(count * secondsPerPhoto)}。` : "";
    return { kind: "new", eyebrow: name, title: `分析${name}`, detail: `${estimate}分析只读取照片，不会修改 Eagle 中的任何内容。`,
      action: { label: `分析这 ${count} 张`, action: "analyze", disabled: submitting } };
  }
  const unfinished = sortTasks(tasks).find(needsAttention);
  if (unfinished) {
    const view = taskView(unfinished, now);
    return { kind: "task", eyebrow: "继续上次的任务", title: view.title, detail: view.detail, task: unfinished, chip: view.chip,
      progress: view.progress, action: { label: view.primary.label, action: view.primary.action },
      note: "要挑新的一批，在 Eagle 里选中文件夹或照片。" };
  }
  return { kind: "empty", eyebrow: "开始", title: "在 Eagle 里选中要挑的照片", detail: "选中一个文件夹或一批照片，这里会出现「分析这 N 张」。",
    action: null };
}

export function libraryAnalysisText(count) {
  return count == null ? "分析整个资源库…" : `分析整个资源库（${count} 张）…`;
}

// Seconds per photo measured on this machine; cached reruns are excluded because they would understate cold cost.
export function measuredRate(runs = []) {
  const rates = runs.filter(run => run.status === "completed" && (run.itemCount || 0) >= 20 &&
    Number(run.progress?.elapsedSeconds) > 0 && !(run.progress?.cached > run.itemCount / 2))
    .map(run => run.progress.elapsedSeconds / run.itemCount).sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)] : null;
}

export function libraryConfirmText(count, secondsPerPhoto = null) {
  const estimate = Number.isFinite(count) && secondsPerPhoto
    ? `，按本机以往速度估算约 ${durationText(count * secondsPerPhoto)}` : "";
  return `将分析整个资源库${Number.isFinite(count) ? ` ${count} 张` : ""}${estimate}。已分析过的照片会复用。期间可以继续使用电脑，确定开始吗？`;
}
