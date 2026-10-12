export async function setWindowMode(reviewing, eagle = globalThis.eagle) {
  if (!reviewing) {
    for (const id of ["panelSettings", "historyView"]) {
      const node = globalThis.document?.querySelector(`#${id}`); if (node) node.hidden = true;
    }
    const home = globalThis.document?.querySelector("#panelHome"); if (home) home.hidden = false;
  }
  const window = eagle?.window;
  if (!window) return;
  try {
    if (reviewing) {
      if (window.maximize) await window.maximize();
      else if (window.setSize) {
        const display = await eagle.screen?.getPrimaryDisplay?.();
        await window.setSize(display?.workAreaSize?.width || globalThis.screen?.availWidth || 1280,
          display?.workAreaSize?.height || globalThis.screen?.availHeight || 800);
      }
    } else { await window.unmaximize?.(); await window.setSize?.(420, 600); }
  } catch { /* Older hosts retain their resizable window. */ }
}
