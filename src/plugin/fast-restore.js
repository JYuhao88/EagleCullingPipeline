export async function restoreBackupThumbnail(item, backup) {
  if (!backup?.outputPath) return { status: "skipped", error: "没有干净备份；未自动重建，请使用重建原生预览" };
  if (typeof item.setCustomThumbnail !== "function") throw new Error("当前 Eagle 不支持 setCustomThumbnail");
  const result = await item.setCustomThumbnail(backup.outputPath);
  if (result === false) throw new Error("Eagle 拒绝写回缩略图备份");
  return { backupSha256: backup.sha256 };
}
