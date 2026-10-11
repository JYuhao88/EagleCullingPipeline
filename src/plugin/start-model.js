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

export const analysisStages = ["扫描", "画质分析", "人脸", "分组", "完成"];
export function stageIndex(stage) {
  if (["scanning", "pairing"].includes(stage)) return 0;
  if (["metrics", "embedding"].includes(stage)) return 1;
  if (["faces", "pose", "focus"].includes(stage)) return 2;
  if (["grouping", "ranking"].includes(stage)) return 3;
  return stage === "done" ? 4 : 0;
}

export function readRecentRuns(storage) {
  try {
    const value = JSON.parse(storage.getItem("eagle-culling-recent-runs") || "[]");
    return Array.isArray(value) ? value.filter(id => typeof id === "string" && /^[\w-]+$/.test(id)).slice(0, 10) : [];
  } catch { return []; }
}
