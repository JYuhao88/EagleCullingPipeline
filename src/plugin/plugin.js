import { createWindowSizer } from './window-mode.js';
import { createApi, resolveBase } from './api.js';
import { createStartView } from './start-view.js';
import { createFinishPanel } from './finish-panel.js';
import { createStarWatcher } from './star-sync.js';
import { startCullingInEagle } from './task-model.js';
import { createCodeReload, fetchPluginStamp } from './code-reload.js';

const root = document;
let api = createApi(localStorage.getItem('eagle-culling-base') || 'http://127.0.0.1:43125');
const finishPanel = createFinishPanel({ root, getApi: () => api,
  show: name => startView.settings.show(name), onComplete: () => startView.refreshTasks() });

async function openTask(runId, { finish = false } = {}) {
  if (finish) return finishPanel.open(runId);
  finishPanel.close();
  startView.setNotice(await startCullingInEagle(api, runId, globalThis.eagle));
}
const startView = createStartView({ root, api, getApi: () => api, onRun: openTask, autoCheck: false });
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
if (globalThis.eagle) {
  starWatcher.start();
  globalThis.eagle.onLibraryChanged?.(() => { starWatcher.reset(); finishPanel.close(); });
  createCodeReload({ fetchStamp: () => fetchPluginStamp(api.base), reload: () => startView.reloadPage(),
    isIdle: () => !startView.view.submitting && !finishPanel.isBusy() && !root.querySelector('dialog[open]')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) }).start();
}

const windowSizer = createWindowSizer();
void windowSizer.restore();

resolveBase().then(base => {
  api = createApi(base);
  root.querySelector('#base').value = base;
  return startView.checkHealth();
}).catch(() => {});
