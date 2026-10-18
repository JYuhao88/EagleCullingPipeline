import { createWindowSizer } from './window-mode.js';
import { createApi, resolveBase } from './api.js';
import { createStartView } from './start-view.js';
import { createFinishPanel } from './finish-panel.js';
import { createStarWatcher } from './star-sync.js';
import { startCullingInEagle } from './task-model.js';
import { createCodeReload, fetchPluginStamp } from './code-reload.js';
import { createWideWatcher, enterWide, isResident, setResident, showWindow } from './wide-mode.js';

const root = document;
const resident = isResident();
if (resident) root.documentElement.dataset.resident = '';
let api = createApi(localStorage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125');
const finishPanel = createFinishPanel({ root, getApi: () => api,
  show: name => startView.settings.show(name), onComplete: () => startView.refreshTasks() });

async function openTask(runId, { finish = false } = {}) {
  if (finish) return finishPanel.open(runId);
  finishPanel.close();
  startView.setNotice(await startCullingInEagle(api, runId, globalThis.eagle));
}
const startView = createStartView({ root, api, getApi: () => api, onRun: openTask, autoCheck: false,
  loadedHidden: resident, onOpen: () => void openFromMenu() });
root.querySelector('#base').value = api.base;
root.querySelector('#base').addEventListener('change', event => {
  finishPanel.close();
  const base = event.target.value.replace(/\/$/, '');
  localStorage.setItem('eagle-culling-base', base);
  api = createApi(base);
  void startView.checkHealth();
});

const starWatcher = createStarWatcher({ eagle: globalThis.eagle, post: async ({ id, action }) => {
  try {
    await api(`/items/${encodeURIComponent(id)}/decision`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryPath: globalThis.eagle?.library?.path || '', action, via: 'eagle-star' }) });
  } catch (error) { if (!(error.status >= 400 && error.status < 500)) throw error; }
}, onLargeSelection: (count, limit) => startView.setNotice(
  `已选 ${count} 张，超过 ${limit} 张时不读取星级；请分批打星，否则不会记为决定。`) });
const working = () => startView.view.submitting || finishPanel.isBusy() || Boolean(root.querySelector('dialog[open]'));
const idle = () => !working() && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
if (globalThis.eagle) {
  starWatcher.start();
  globalThis.eagle.onLibraryChanged?.(() => { starWatcher.reset(); finishPanel.close(); });
  createCodeReload({ fetchStamp: () => fetchPluginStamp(api.base), reload: () => startView.reloadPage(), isIdle: idle }).start();
}

const windowSizer = createWindowSizer();
// Back from a closed wide window the size is the wide one, possibly maximized: resizing a hidden window can show it.
if (!resident) void windowSizer.restore();

let leaving = false;
async function openWide() {
  if (!isResident()) await windowSizer.remember();
  leaving = true; setResident(false); enterWide();
}
// The plugin menu opens the wide inspector; 返回主界面 there leads here. Focus left in a field of a window the user
// already closed is no reason to stay.
async function openFromMenu() {
  if (isResident() || !working()) await openWide();
  else startView.setNotice('先完成当前操作，再点「宽屏检查器」。');
}
// Shown by something other than the plugin menu: be the main page again.
if (resident) globalThis.eagle?.onPluginShow?.(() => setTimeout(() => {
  if (leaving || !isResident()) return;
  setResident(false); delete root.documentElement.dataset.resident;
}, 1500));
root.querySelector('#openWide').addEventListener('click', () => void openWide());
if (globalThis.eagle) createWideWatcher({ getBase: () => api.base, onRequest: async () => {
  await showWindow(globalThis.eagle);
  if (!working()) await openWide();
  else startView.setNotice('右栏请求了宽屏查看：先完成当前操作，再点「宽屏检查器」。');
} }).start();

resolveBase().then(base => {
  api = createApi(base);
  root.querySelector('#base').value = base;
  return startView.checkHealth();
}).catch(() => {});
