// Shows photos in Eagle. Builds with item.select select them; older builds only follow an eagle://item link,
// which opens the first photo. Returns 'selected', 'opened' or 'none'.
export const canSelectInEagle = eagle => typeof eagle?.item?.select === 'function';

export async function showInEagle(eagle, ids, open = globalThis.open) {
  if (!ids?.length) return 'none';
  if (canSelectInEagle(eagle)) { await eagle.item.select(ids); return 'selected'; }
  const url = `eagle://item/${encodeURIComponent(ids[0])}`;
  if (typeof eagle?.shell?.openExternal === 'function') { await eagle.shell.openExternal(url); return 'opened'; }
  if (typeof open === 'function') { open(url); return 'opened'; }
  return 'none';
}
