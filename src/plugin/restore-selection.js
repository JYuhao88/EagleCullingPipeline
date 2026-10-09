const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "3fr", "arw", "dng", "cr2", "cr3", "nef", "raf", "orf", "rw2", "tif", "tiff"]);

export async function confirmSelectedRestore(api, confirm) {
  const selected = await api.item.getSelected();
  const images = selected.filter((item) => IMAGE_EXTENSIONS.has(String(item.ext || "").toLowerCase().replace(/^\./, "")));
  if (!images.length) throw new Error("请先在 Eagle 主窗口选择带旧角标的照片");
  const names = images.slice(0, 5).map((item) => item.name || item.id).join("、");
  const approved = confirm(`恢复当前明确选中的 ${images.length} 张照片的原生缩略图？\n${names}${images.length > 5 ? "…" : ""}\n\n会移除旧版 AI 角标，也会替换这些照片原有的人工自定义缩略图。\n不删除照片，不修改标签、星级或文件夹。仅恢复缩略图，不能撤销 AI 标签。`);
  return approved ? images : [];
}

export async function refreshNativeThumbnail(item) {
  if (typeof item.refreshThumbnail !== "function") throw new Error("当前 Eagle API 不支持 refreshThumbnail");
  const ok = await item.refreshThumbnail();
  if (ok !== true) throw new Error("Eagle 返回缩略图恢复失败");
}
