// The wide inspector is the right-panel page opened inside the main plugin window: Eagle's right panel stays between
// 200 and 600 px, the plugin window can fill the screen.
export function isWide(pageUrl) {
  try { return new URL(pageUrl).searchParams.get('mode') === 'wide'; } catch { return false; }
}

// Eagle opens the main page with ?theme=…&locale=…; both pages keep those.
export function wideUrl(search = '') {
  const params = new URLSearchParams(search); params.set('mode', 'wide');
  return `inspector/index.html?${params}`;
}

export function mainUrl(search = '') {
  const params = new URLSearchParams(search); params.delete('mode'); params.delete('id');
  const query = String(params);
  return `../index.html${query ? `?${query}` : ''}`;
}

// Only an explicit switch maximizes: a code reload of a hidden wide page must not (maximize also shows the window).
const FILL_KEY = 'eagle-culling-wide-fill';

export function enterWide(win = globalThis.window) {
  try { win.sessionStorage?.setItem(FILL_KEY, '1'); } catch { /* the window keeps its size */ }
  win.__ecAllowUnload = true;
  win.location.assign(wideUrl(win.location.search));
}

export function takeFill(win = globalThis.window) {
  try {
    const fill = win?.sessionStorage?.getItem(FILL_KEY) === '1';
    win?.sessionStorage?.removeItem(FILL_KEY);
    return fill;
  } catch { return false; }
}

export async function requestWide(base, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${base}/ui/wide`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('宽屏请求失败');
}

export async function showWindow(eagle) {
  const win = eagle?.window;
  try {
    if (await win?.isMinimized?.()) await win.restore?.();
    await win?.show?.(); await win?.focus?.();
  } catch { /* an older Eagle keeps the window where it is */ }
}

export async function fillScreen(eagle) {
  const win = eagle?.window;
  try {
    if (win?.maximize) { await win.maximize(); return; }
    const area = (await eagle?.screen?.getPrimaryDisplay?.())?.workAreaSize;
    if (area && win?.setSize) await win.setSize(area.width, area.height);
  } catch { /* the window keeps its size */ }
}

export async function unfillScreen(eagle) {
  try { await eagle?.window?.unmaximize?.(); } catch { /* the main page restores its saved size */ }
}

// Waits on the service for 宽屏查看 clicks from Eagle's right panel. The first answer only sets the baseline; a new
// service `boot` means a restart, where any request counts.
export function createWideWatcher({ getBase, onRequest, fetchImpl = globalThis.fetch, holdMs = 25000, retryMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let running = false, controller = null, pause = null, boot = null, seq = 0;
  async function once() {
    controller = new AbortController();
    const started = now(), timer = setTimer(() => controller.abort(), holdMs + 5000);
    try {
      const query = boot === null ? '' : `?boot=${encodeURIComponent(boot)}&after=${seq}`;
      const response = await fetchImpl(`${getBase()}/ui/wide${query}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok || typeof body.boot !== 'string' || !Number.isInteger(body.seq)) throw new Error('宽屏状态无效');
      const same = body.boot === boot && body.seq === seq;
      const fresh = boot !== null && !same && (body.boot !== boot ? body.seq > 0 : body.seq > seq);
      boot = body.boot; seq = body.seq;
      if (fresh) await onRequest();
      // An unchanged answer that did not wait means the service does not hold the request: back off instead of spinning.
      return !same || now() - started >= 1000;
    } finally { clearTimer(timer); }
  }
  async function loop() {
    while (running) {
      if (await once().catch(() => false) || !running) continue;
      await new Promise(resolve => { pause = { resolve, timer: setTimer(resolve, retryMs) }; });
      pause = null;
    }
  }
  return {
    once,
    start() { if (!running) { running = true; void loop(); } },
    stop() {
      running = false; controller?.abort();
      if (pause) { clearTimer(pause.timer); pause.resolve(); }
    },
  };
}
