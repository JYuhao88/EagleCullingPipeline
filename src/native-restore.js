function humanMetadata(item) {
  return JSON.stringify({name:item.name,ext:item.ext,tags:[...(item.tags || [])].sort(),folders:[...(item.folders || [])].sort(),star:item.star,annotation:item.annotation,url:item.url});
}
const modified = item => item.modificationTime ?? item.modifiedAt;

// Used only by an explicitly confirmed, leased executor, not an automatic
// fallback from a thumbnail display toggle. No metadata/file update calls.
export async function restoreNativeVerified({api,itemId,libraryPath,expectedModifiedAt,fingerprintOriginal,beforeWrite} = {}) {
  if (!Number.isFinite(expectedModifiedAt) || !libraryPath || !itemId || typeof fingerprintOriginal !== "function" || typeof beforeWrite !== "function") throw new Error("原生恢复需要明确项目、修改时间、原片校验与执行权检查");
  const libraryGuard = async () => {
    if ((await api.libraryInfo()).path !== libraryPath) throw Object.assign(new Error("资源库已切换，停止原生恢复"),{fatal:true});
  };
  const readItem = async () => {
    const page=await api.get("item/get",{id:itemId,limit:1});
    const item=page?.data?.find(item=>item.id===itemId && !item.isDeleted);
    if (!item) throw Object.assign(new Error("恢复项目缺失或已删除"),{fatal:true});
    return item;
  };
  const fingerprint = async () => {
    const hash=await fingerprintOriginal();
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("原片校验未返回有效 SHA-256");
    return hash;
  };
  await beforeWrite();await libraryGuard();
  const before=await readItem();
  if (modified(before)!==expectedModifiedAt) return {status:"skipped",error:"项目在计划后发生变化，未重建缩略图"};
  const originalSha256=await fingerprint();
  await beforeWrite();await libraryGuard();
  const fresh=await readItem();
  if (modified(fresh)!==expectedModifiedAt || humanMetadata(fresh)!==humanMetadata(before)) return {status:"skipped",error:"原片校验期间项目变化，未重建缩略图"};
  await beforeWrite();await libraryGuard();
  try {
    await api.refreshThumbnail(itemId);
    await libraryGuard();
    const after=await readItem();
    const originalSha256After=await fingerprint();
    if (originalSha256After!==originalSha256) throw new Error("原片 SHA-256 发生变化，停止后续操作");
    if (humanMetadata(after)!==humanMetadata(before)) throw new Error("人工信息发生变化，停止后续操作；不会自动回滚覆盖");
    return {acknowledged:true,originalSha256Unchanged:true,humanMetadataUnchanged:true,previewVerified:false,derivedDimensions:{before:[before.width,before.height],after:[after.width,after.height]}};
  } catch (error) {
    error.fatal=true;error.refreshOutcome="unknown";throw error;
  }
}
