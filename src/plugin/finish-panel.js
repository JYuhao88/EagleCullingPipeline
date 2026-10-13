import { createWritebackDialog } from './writeback-dialog.js';

export function finishModel(data, response, base, runId) {
  const counts = { selected: 0, candidate: 0, rejected: 0 };
  for (const row of response.queue || response.items || []) if (Object.hasOwn(counts, row.human)) counts[row.human]++;
  const decided = counts.selected + counts.candidate + counts.rejected;
  const total = response.total ?? (response.queue || response.items || []).length;
  const path = `${base}/runs/${encodeURIComponent(runId)}/report?format=`;
  return { title: data.run?.scope?.label || runId, counts, decided, total,
    text: `已决定 ${decided} / ${total} 张 · 精选 ${counts.selected} · 候选 ${counts.candidate} · 淘汰 ${counts.rejected}`,
    canRevert: Boolean(data.writebackAvailable), csvUrl: `${path}csv`, jsonUrl: `${path}json` };
}

export function createFinishPanel({ root, getApi, show, onComplete = () => {} }) {
  const q = id => root.querySelector(`#${id}`);
  let runId = null, taskApi = null, version = 0, loading = false;
  const dialog = createWritebackDialog({ root, api: (...args) => taskApi(...args), getRunId: () => runId,
    onComplete: () => { void Promise.resolve().then(refresh); void onComplete(); } });

  async function refresh() {
    if (!runId || dialog.isBusy()) return;
    const token = ++version, id = runId, api = taskApi;
    loading = true;
    q('dryRun').disabled = true;
    q('refreshFinish').disabled = true;
    q('revertWriteback').hidden = true;
    q('finishCounts').textContent = '正在读取决定…';
    try {
      const [data, response] = await Promise.all([
        api(`/runs/${encodeURIComponent(id)}/results?limit=1&filter=all`),
        api(`/runs/${encodeURIComponent(id)}/queue?mode=all`)
      ]);
      if (token !== version) return;
      const model = finishModel(data, response, api.base, id);
      q('finishTask').textContent = model.title;
      q('finishCounts').textContent = model.text;
      q('reportCsv').href = model.csvUrl;
      q('reportJson').href = model.jsonUrl;
      q('revertWriteback').hidden = !model.canRevert;
      q('dryRun').disabled = false;
    } catch (error) {
      if (token === version) q('finishCounts').textContent = `无法读取决定：${error.message}。请重试。`;
    } finally {
      if (token === version) { loading = false; q('refreshFinish').disabled = false; }
    }
  }

  async function open(id) {
    if (dialog.isBusy() || q('writebackDialog').open) return;
    runId = id;
    taskApi = getApi();
    q('finishTask').textContent = id;
    q('writeback').textContent = '';
    for (const key of ['reportCsv', 'reportJson']) q(key).removeAttribute('href');
    show('finishPanel');
    await refresh();
  }
  function close() {
    version++; loading = false; runId = null;
    q('writebackDialog').close();
    show('panelHome');
  }
  q('closeFinish').addEventListener('click', () => { if (!dialog.isBusy()) close(); });
  q('refreshFinish').addEventListener('click', refresh);
  return { open, close, refresh, isBusy: () => loading || dialog.isBusy() };
}
