// Eagle keeps plugin pages alive (the main window runs as a background service), so new plugin code would
// otherwise wait for an Eagle restart. The service reports a fingerprint of the plugin sources; when it
// changes, the page reloads itself as soon as it is idle.
export function createCodeReload({ fetchStamp, reload, isIdle = () => true, interval = 4000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let baseline = null, timer = null, running = false;
  async function tick() {
    let stamp;
    try { stamp = await fetchStamp(); } catch { return false; }
    if (!stamp) return false;
    if (baseline === null) { baseline = stamp; return false; }
    if (stamp === baseline || !isIdle()) return false;
    running = false; clearTimer(timer);
    reload();
    return true;
  }
  function loop() {
    if (!running) return;
    void tick().finally(() => { if (running) timer = setTimer(loop, interval); });
  }
  return { tick, start() { if (!running) { running = true; loop(); } }, stop() { running = false; clearTimer(timer); } };
}

export async function fetchPluginStamp(base, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${String(base).replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  return response.ok && body.service === 'eagle-culling' ? body.pluginStamp || null : null;
}
