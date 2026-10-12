export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export function shouldAutoUpdate({ status, enabled, reviewing, postponed }) {
  return Boolean(enabled && !reviewing && !postponed && status.hasUpdate && status.canUpdate && !status.checkError);
}

export function mountUpdates({ root = document, storage = localStorage, fetchImpl = fetch, reload = () => location.reload() } = {}) {
  const panel = root.createElement('aside');
  panel.className = 'update-panel';
  panel.innerHTML = `<div class="update-banner" hidden role="status"><span></span>
    <button data-action="notes">查看更新内容</button><button data-action="apply">立即更新</button>
    <button data-action="later">稍后</button></div>
    <details class="update-about"><summary>关于 / 更新</summary><p data-version>正在读取版本…</p>
    <label><input type="checkbox" data-auto> 自动更新（空闲且在主页时）</label>
    <button data-action="check">检查更新</button><button data-action="rollback">回退到上一版</button>
    <p data-status role="status"></p><pre data-notes hidden></pre></details>`;
  (root.querySelector('#start') || root.querySelector('#app')).prepend(panel);
  const el = selector => panel.querySelector(selector);
  const auto = el('[data-auto]');
  auto.checked = storage.getItem('eagle-culling-auto-update') !== 'false';
  let status = {}, operation = false, postponed = false, checking = false, timer, loaded = false;
  const completionNotice = storage.getItem('eagle-culling-update-result');
  const reviewing = () => !root.querySelector('#review')?.hidden;
  const base = () => root.querySelector('#base').value.replace(/\/$/, '');
  const key = () => `eagle-culling-update:${base()}`;
  async function api(route, method = 'GET') {
    const response = await fetchImpl(`${base()}/update/${route}`, { method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '服务暂时无法连接');
    return value;
  }
  function render() {
    el('[data-version]').textContent = `当前版本 ${status.currentVersion || status.packageVersion || '未知'}`;
    el('[data-action="rollback"]').disabled = !status.canRollback || operation;
    el('[data-action="apply"]').disabled = !status.canUpdate || operation;
    el('[data-notes]').textContent = status.releaseNotes || '暂无更新说明';
    const banner = el('.update-banner');
    banner.hidden = postponed || !status.hasUpdate && !operation && !status.error;
    banner.querySelector('span').textContent = operation ? '正在更新，请稍候…'
      : status.error ? `更新失败：${status.error}` : `有新版本 ${status.latestVersion}`;
    const text = status.error || status.checkError || status.reason;
    el('[data-status]').textContent = text || completionNotice
      || (status.hasUpdate ? `最新正式版 ${status.latestVersion}` : '当前已是最新正式版');
  }
  async function check() {
    if (checking || operation) return;
    checking = true;
    try {
      status = await api('status'); loaded = true;
      storage.setItem(key(), JSON.stringify({ checked: Date.now(), status }));
      render();
    } catch (error) { el('[data-status]').textContent = `检查未完成：${error.message}`; }
    finally { checking = false; }
    await automatic();
  }
  async function automatic() {
    if (loaded && shouldAutoUpdate({ status, enabled: auto.checked, reviewing: reviewing(), postponed }) && !operation) {
      await apply('apply');
    }
  }
  async function apply(action) {
    if (operation) return;
    if (reviewing()) {
      el('[data-status]').textContent = '请先返回主页，再更新或回退。';
      el('.update-about').open = true; return;
    }
    operation = true;
    let seenProgress = false;
    const started = Date.now();
    try {
      await api(action, 'POST'); render();
      for (;;) {
        await new Promise(resolve => { timer = setTimeout(resolve, 1000); });
        if (Date.now() - started > 15 * 60 * 1000) throw new Error('等待更新超时，请查看关于 / 更新或服务日志');
        let value;
        try { value = await api('status'); } catch { continue; }
        status = value;
        if (['download', 'install', 'restart', 'pending'].includes(value.phase)) seenProgress = true;
        const progressText = { download: '下载新版本…', install: '安装依赖…', restart: '重启服务…' }[value.phase]
          || '正在准备更新…';
        el('[data-status]').textContent = progressText;
        el('.update-banner span').textContent = progressText;
        if (value.phase === 'failed') throw new Error(value.error || '更新失败，已尝试恢复原版本');
        if (value.phase === 'completed' && (seenProgress || Date.now() - started > 2000)) {
          storage.removeItem(key());
          storage.setItem('eagle-culling-update-result', value.pythonChanged
            ? '更新完成；Python 依赖有变化，请按更新说明手动安装。' : '更新完成，插件已重新加载。');
          reload(); return;
        }
      }
    } catch (error) {
      status.error = error.message;
      postponed = true;
      operation = false;
      render();
      el('.update-banner').hidden = false;
      el('.update-about').open = true;
    } finally { operation = false; }
  }
  auto.addEventListener('change', () => {
    storage.setItem('eagle-culling-auto-update', String(auto.checked));
    if (auto.checked) { postponed = false; check(); }
  });
  panel.addEventListener('click', event => {
    const action = event.target.dataset.action;
    if (action === 'notes') { el('.update-about').open = true; el('[data-notes]').hidden = false; }
    if (action === 'later') { postponed = true; render(); }
    if (action === 'check') { postponed = true; check(); }
    if (['apply', 'rollback'].includes(action)) apply(action);
  });
  const observer = new MutationObserver(() => { if (!reviewing() && loaded && !operation && !postponed) check(); });
  observer.observe(root.querySelector('#review'), { attributes: true, attributeFilter: ['hidden'] });
  root.querySelector('#base').addEventListener('change', () => { loaded = false; check(); });
  const result = completionNotice;
  if (result) {
    el('[data-status]').textContent = result; el('.update-about').open = true;
    storage.removeItem('eagle-culling-update-result');
  }
  // The server enforces the network interval; always refresh local safety/run state.
  check();
  const idle = setInterval(() => { if (!reviewing() && !operation) check(); }, 60000);
  return () => { clearInterval(idle); clearTimeout(timer); observer.disconnect(); panel.remove(); };
}

if (typeof document !== 'undefined' && document.querySelector('#app')) mountUpdates();
