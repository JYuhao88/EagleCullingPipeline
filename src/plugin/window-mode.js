const SIZE_KEY = 'eagle-culling-window-size';
const MIN_SIZE = { width: 360, height: 480 };

// The plugin never resizes Eagle's window on its own; only the user's zoom button does.
export async function setWindowMode(reviewing) {
  if (reviewing) return;
  for (const id of ["panelSettings", "historyView"]) {
    const node = globalThis.document?.querySelector(`#${id}`); if (node) node.hidden = true;
  }
  const home = globalThis.document?.querySelector("#panelHome"); if (home) home.hidden = false;
}

export function readSavedSize(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(SIZE_KEY) || 'null');
    if (!Number.isFinite(value?.width) || !Number.isFinite(value?.height)) return null;
    return { width: Math.max(MIN_SIZE.width, Math.round(value.width)), height: Math.max(MIN_SIZE.height, Math.round(value.height)) };
  } catch { return null; }
}

export function createWindowSizer({ eagle = globalThis.eagle, storage = globalThis.localStorage, win = globalThis.window,
  root = globalThis.document, delay = 400 } = {}) {
  const host = eagle?.window;
  let timer = null, zoomed = false, restoring = false;
  const supported = Boolean(host?.maximize || host?.setSize);
  async function currentSize() {
    let size = null;
    try { size = await host?.getSize?.(); } catch { /* fall back to the DOM window */ }
    if (Array.isArray(size) && size.length === 2) return { width: size[0], height: size[1] };
    return win ? { width: win.outerWidth || win.innerWidth, height: win.outerHeight || win.innerHeight } : null;
  }
  async function isMaximized() {
    try { return Boolean(await host?.isMaximized?.()) || zoomed; } catch { return zoomed; }
  }
  async function remember() {
    if (restoring || await isMaximized()) return;
    const size = await currentSize();
    if (size?.width >= MIN_SIZE.width && size?.height >= MIN_SIZE.height) storage?.setItem(SIZE_KEY, JSON.stringify(size));
  }
  function render() {
    for (const button of root?.querySelectorAll?.('[data-window-zoom]') || []) {
      button.hidden = !supported;
      button.textContent = zoomed ? '还原窗口' : '放大审阅';
      button.setAttribute('aria-pressed', String(zoomed));
    }
  }
  async function restore() {
    const saved = readSavedSize(storage);
    if (!saved || !host?.setSize) return false;
    restoring = true;
    try { await host.setSize(saved.width, saved.height); return true; } catch { return false; } finally { restoring = false; }
  }
  async function toggle() {
    if (!supported) return zoomed;
    try {
      if (zoomed) {
        await host.unmaximize?.();
        zoomed = false;
        await restore();
      } else {
        await remember();
        if (host.maximize) await host.maximize();
        else {
          const display = await eagle.screen?.getPrimaryDisplay?.();
          await host.setSize(display?.workAreaSize?.width || globalThis.screen?.availWidth || 1280,
            display?.workAreaSize?.height || globalThis.screen?.availHeight || 800);
        }
        zoomed = true;
      }
    } catch { /* Older hosts keep their own resizable window. */ }
    render();
    return zoomed;
  }
  function onResize() { clearTimeout(timer); timer = setTimeout(() => { void remember(); }, delay); }
  win?.addEventListener?.('resize', onResize);
  root?.addEventListener?.('click', event => {
    if (event.target?.closest?.('[data-window-zoom]')) void toggle();
  });
  render();
  return { restore, toggle, remember, render, isZoomed: () => zoomed, supported };
}
