// Shows photos in Eagle. Builds with item.select select them; older builds only follow an eagle://item link,
// which opens the first photo. Returns 'selected', 'opened' or 'none'.
export const canSelectInEagle = eagle => typeof eagle?.item?.select === 'function';

// item.select leaves the grid where it is. Eagle's window answers its internal 'rebind-refresh' message by
// refreshing the current view (same folder and filters) and scrolling to the selection only when it is off screen.
export function revealSelection(ipc = globalThis.require?.('electron')?.ipcRenderer, parentId = globalThis.parentID) {
  if (typeof ipc?.sendTo !== 'function' || parentId === undefined || parentId === null) return false;
  try { ipc.sendTo(parentId, 'rebind-refresh'); return true; } catch { return false; }
}

export async function showInEagle(eagle, ids, open = globalThis.open, reveal = revealSelection) {
  if (!ids?.length) return 'none';
  if (canSelectInEagle(eagle)) { await eagle.item.select(ids); reveal(); return 'selected'; }
  const url = `eagle://item/${encodeURIComponent(ids[0])}`;
  if (typeof eagle?.shell?.openExternal === 'function') { await eagle.shell.openExternal(url); return 'opened'; }
  if (typeof open === 'function') { open(url); return 'opened'; }
  return 'none';
}
