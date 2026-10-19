import { createWritebackDialog } from './writeback-dialog.js';
import { aiTagsEnabled } from './live-writeback.js';

export function finishModel(data, response, base, runId) {
  const counts = { selected: 0, candidate: 0, rejected: 0, record: 0 };
  for (const row of response.queue || response.items || []) if (Object.hasOwn(counts, row.human)) counts[row.human]++;
  const decided = counts.selected + counts.candidate + counts.rejected + counts.record;
  const total = response.total ?? (response.queue || response.items || []).length;
  const path = `${base}/runs/${encodeURIComponent(runId)}/report?format=`;
  return { title: data.run?.scope?.label || runId, counts, decided, total,
    text: `已决定 ${decided} / ${total} 张 · 精选 ${counts.selected} · 候选 ${counts.candidate} · 淘汰 ${counts.rejected}`
      + (counts.record ? ` · 留存 ${counts.record}` : ''),
    canRevert: Boolean(data.writebackAvailable), csvUrl: `${path}csv`, jsonUrl: `${path}json` };
}

export function trashSummary({ units = 0, count = 0, skipped = 0 } = {}) {
  if (!count) return units ? '标为淘汰的照片都已不在资源库里，没有要移动的。' : '这批照片里还没有你标为淘汰的。';
  const files = count === units ? '' : `（共 ${count} 个文件，RAW+JPEG 一起移）`;
  const gone = skipped ? `；${skipped} 个文件已不在资源库里，跳过` : '';
  return `将把你标为淘汰的 ${units} 张照片${files}移入 Eagle 回收站${gone}。可在 Eagle 回收站恢复。`;
}

export function createFinishPanel({ root, getApi, show, onComplete = () => {}, storage = globalThis.localStorage }) {
  const q = id => root.querySelector(`#${id}`);
  let runId = null, taskApi = null, version = 0, loading = false, trashing = false, trashRun = null;
  const dialog = createWritebackDialog({ root, api: (...args) => taskApi(...args), getRunId: () => runId,
    onComplete: () => { void Promise.resolve().then(refresh); void onComplete(); } });
  const post = (path, body) => taskApi(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });

  async function refresh() {
    if (!runId || dialog.isBusy()) return;
    const token = ++version, id = runId, api = taskApi;
    loading = true;
    q('dryRun').disabled = true;
    q('trashRejected').disabled = true;
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
      const tags = aiTagsEnabled(storage);
      q('finishTask').textContent = model.title;
      q('finishCounts').textContent = model.text;
      q('reportCsv').href = model.csvUrl;
      q('reportJson').href = model.jsonUrl;
      // Tags written earlier stay revertible after the setting is turned off.
      q('tagWriteback').hidden = !tags && !model.canRevert;
      q('dryRun').hidden = !tags;
      q('revertWriteback').hidden = !model.canRevert;
      q('dryRun').disabled = false;
      q('trashRejected').disabled = !model.counts.rejected;
    } catch (error) {
      if (token === version) q('finishCounts').textContent = `无法读取决定：${error.message}。请重试。`;
    } finally {
      if (token === version) { loading = false; q('refreshFinish').disabled = false; }
    }
  }

  async function previewTrash() {
    if (trashing || !runId) return;
    const id = runId;
    trashing = true; q('trashRejected').disabled = true;
    q('trashResult').textContent = '正在检查要移动的照片…';
    try {
      const preview = await post(`/runs/${encodeURIComponent(id)}/trash-rejected`, { apply: false });
      if (id !== runId) return;
      q('trashResult').textContent = preview.count ? '' : trashSummary(preview);
      if (!preview.count) return;
      trashRun = id;
      const files = preview.files || [];
      q('trashSummary').textContent = trashSummary(preview);
      q('trashFiles').textContent = files.join('\n') + (preview.count > files.length ? `\n仅显示前 ${files.length} 个。` : '');
      q('trashConfirm').value = '';
      q('confirmTrash').disabled = true;
      q('trashDialog').showModal?.();
    } catch (error) { q('trashResult').textContent = `无法检查要移动的照片：${error.message}`; }
    finally { trashing = false; q('trashRejected').disabled = false; }
  }

  async function confirmTrash() {
    if (trashing || !trashRun || trashRun !== runId || q('trashConfirm').value.trim() !== 'MOVE_TO_TRASH') return;
    trashing = true; q('confirmTrash').disabled = true;
    try {
      const result = await post(`/runs/${encodeURIComponent(trashRun)}/trash-rejected`, { apply: true, confirm: 'MOVE_TO_TRASH' });
      const rows = result.trash || [], failed = rows.filter(row => !row.ok);
      q('trashResult').textContent = `已移入 Eagle 回收站 ${rows.length - failed.length} 个文件`
        + (failed.length ? `，失败 ${failed.length} 个：${failed[0].error || '原因未知'}` : '') + '。';
      void onComplete();
    } catch (error) { q('trashResult').textContent = `移入回收站失败：${error.message}`; }
    finally { trashing = false; trashRun = null; q('trashDialog').close?.(); }
  }

  async function open(id) {
    if (dialog.isBusy() || trashing || q('writebackDialog').open || q('trashDialog').open) return;
    runId = id;
    taskApi = getApi();
    q('finishTask').textContent = id;
    q('writeback').textContent = '';
    q('trashResult').textContent = '';
    for (const key of ['reportCsv', 'reportJson']) q(key).removeAttribute('href');
    show('finishPanel');
    await refresh();
  }
  function close() {
    version++; loading = false; runId = null; trashRun = null;
    q('writebackDialog').close();
    q('trashDialog').close?.();
    if (!q('finishPanel').hidden) show('historyView');
  }
  q('closeFinish').addEventListener('click', () => { if (!dialog.isBusy() && !trashing) close(); });
  q('refreshFinish').addEventListener('click', refresh);
  q('trashRejected').addEventListener('click', () => void previewTrash());
  q('trashConfirm').addEventListener('input', () => {
    q('confirmTrash').disabled = q('trashConfirm').value.trim() !== 'MOVE_TO_TRASH';
  });
  q('confirmTrash').addEventListener('click', () => void confirmTrash());
  q('cancelTrash').addEventListener('click', () => { trashRun = null; q('trashDialog').close?.(); });
  return { open, close, refresh, isBusy: () => loading || trashing || dialog.isBusy() };
}
