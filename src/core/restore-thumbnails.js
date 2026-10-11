export async function restoreThumbnails(
  api,
  ids,
  { apply = false, confirm = "" } = {},
) {
  const results = [];
  if (apply && confirm !== "RESTORE_THUMBNAILS")
    throw new Error("--apply requires --confirm RESTORE_THUMBNAILS");
  for (const id of ids) {
    if (!apply) {
      results.push({ id, dryRun: true });
      continue;
    }
    try {
      await api.refreshThumbnail(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  return results;
}
