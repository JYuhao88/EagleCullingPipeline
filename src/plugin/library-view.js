import { placeStatus, librarySummary, folderRows, initialExpanded, rowDetail } from './library-model.js';
import { showInEagle } from './eagle-select.js';

// The library page: Eagle's folder tree with how far each folder is analyzed, and the analysis queue.
// Nothing here starts on its own; every analysis comes from an explicit 排队.
export function mountLibraryView({ root, getApi, getLibraryPath, performanceMode = () => 'normal', onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const q = id => root.querySelector(`#${id}`);
  const state = { overview: null, expanded: null, visible: false, busy: false, notice: '' };
  let timer = null, version = 0;

  const button = (label, onClick, className = '') => {
    const node = root.createElement('button');
    node.textContent = label; if (className) node.className = className;
    node.addEventListener('click', event => { event?.stopPropagation?.(); void onClick(); });
    return node;
  };
  const text = (tag, value, className = '') => {
    const node = root.createElement(tag); node.textContent = value; if (className) node.className = className; return node;
  };
  const libraryQuery = () => `libraryPath=${encodeURIComponent(getLibraryPath())}`;

  async function act(request, notice) {
    if (state.busy) return;
    state.busy = true; render();
    try {
      const response = await request();
      if (notice) state.notice = typeof notice === 'function' ? notice(response) : notice;
      onChange(response);
    } catch (error) { state.notice = `操作失败：${error.message}`; }
    finally { state.busy = false; await refresh(); }
  }
  const post = (path, body = {}, method = 'POST') => getApi()(path, { method, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryPath: getLibraryPath(), ...body }) });
  const enqueue = scopes => act(() => post('/queue', { scopes, performanceMode: performanceMode() }),
    response => response.started ? '已开始分析。' : response.added ? '已排队，轮到时自动开始。' : '已经在排队了。');

  async function selectUnanalyzed(row) {
    await act(async () => {
      const scope = row.unfiled ? 'unfiled=1' : `folderId=${encodeURIComponent(row.id)}`;
      const response = await getApi()(`/library/unanalyzed?${libraryQuery()}&${scope}`);
      const shown = await showInEagle(globalThis.eagle, response.itemIds);
      return { ...response, shown };
    }, response => response.shown === 'selected'
      ? `已在 Eagle 里选中 ${response.itemIds.length} 张未分析的照片${
        response.total > response.itemIds.length ? `（共 ${response.total} 张，先选前一部分）` : ''}。`
      : '这个版本的 Eagle 不能由插件选中照片。');
  }

  function folderRow(row) {
    const own = placeStatus(row);
    const status = own.state === 'empty' && row.hasChildren
      ? placeStatus({ count: row.subtree.count, analyzed: row.subtree.analyzed }) : own;
    const node = root.createElement('div');
    node.className = 'folder-row';
    if (node.dataset) { node.dataset.state = status.state; node.dataset.folderId = row.id || 'unfiled'; }
    node.setAttribute?.('style', `--depth:${row.depth}`);
    const fold = row.hasChildren ? button(row.open ? '▾' : '▸', () => {
      if (state.expanded.has(row.id)) state.expanded.delete(row.id); else state.expanded.add(row.id);
      render();
    }, 'fold') : text('span', '', 'fold');
    const body = root.createElement('div'); body.className = 'folder-body';
    const head = root.createElement('div'); head.className = 'folder-head';
    head.append(text('strong', row.name), text('span', own.state === 'empty' && row.hasChildren && status.chip
      ? `子文件夹 ${status.chip}` : status.chip, 'chip'));
    body.append(head, text('p', rowDetail(row), 'folder-meta'));
    const actions = root.createElement('div'); actions.className = 'folder-actions';
    const scope = row.unfiled ? { type: 'unfiled' } : { type: 'folder', folderId: row.id };
    const entry = (state.overview?.queue || []).find(item => row.unfiled ? item.type === 'unfiled' : item.folderId === row.id);
    if (['none', 'partial'].includes(own.state)) {
      actions.append(button('排队', () => enqueue([scope]), 'queue'),
        button(`选中未分析的 ${row.count - row.analyzed} 张`, () => selectUnanalyzed(row), 'quiet'));
    } else if (own.state === 'queued' && entry) {
      if (entry.position > 1) actions.append(button('置顶', () => act(() => post(`/queue/${entry.id}/top`)), 'quiet'));
      actions.append(button('取消排队', () => act(() => post(`/queue/${entry.id}`, {}, 'DELETE')), 'quiet'));
    }
    for (const control of actions.children || []) control.disabled = state.busy;
    node.append(fold, body, actions);
    return node;
  }

  function queueRows() {
    const overview = state.overview, rows = [];
    if (overview?.active) {
      rows.push(text('p', `正在分析「${overview.active.label}」${overview.active.percent == null ? ''
        : ` ${Math.floor(overview.active.percent)}%`}`, 'queue-active'));
    }
    for (const entry of overview?.queue || []) {
      const row = root.createElement('div'); row.className = 'queue-row';
      row.append(text('span', `${entry.position}. ${entry.label}`));
      if (entry.position > 1) row.append(button('置顶', () => act(() => post(`/queue/${entry.id}/top`)), 'quiet'));
      row.append(button('取消', () => act(() => post(`/queue/${entry.id}`, {}, 'DELETE')), 'quiet'));
      rows.push(row);
    }
    return rows;
  }

  function render() {
    const overview = state.overview;
    if (q('librarySummary')) q('librarySummary').textContent = librarySummary(overview)
      || (getLibraryPath() ? '正在读取资源库…' : '请在 Eagle 打开一个资源库');
    if (q('libraryNotice')) q('libraryNotice').textContent = state.notice;
    q('libraryQueue')?.replaceChildren(...queueRows());
    const rows = overview ? folderRows(overview, state.expanded || new Set()) : [];
    q('libraryTree')?.replaceChildren(...rows.map(folderRow));
    const all = q('queueAllUnanalyzed');
    if (all) { all.hidden = !overview || overview.analyzed >= overview.total; all.disabled = state.busy; }
    const clear = q('clearQueue');
    if (clear) { clear.hidden = !overview?.queue?.length; clear.disabled = state.busy; }
  }

  async function refresh() {
    clearTimer(timer); timer = null;
    if (!getLibraryPath()) { state.overview = null; render(); return; }
    const token = ++version;
    try {
      const overview = await getApi()(`/library/overview?${libraryQuery()}`);
      if (token !== version) return;
      if (state.notice.startsWith('读取资源库失败')) state.notice = '';
      state.overview = overview;
      state.expanded ||= initialExpanded(overview);
    } catch (error) { if (token === version) state.notice = `读取资源库失败：${error.message}`; }
    render();
    if (state.visible) {
      const moving = state.overview?.active || state.overview?.queue?.length;
      timer = setTimer(() => void refresh(), moving ? 3000 : 20000);
    }
  }

  q('queueAllUnanalyzed')?.addEventListener('click', () => act(() => post('/queue', { allUnanalyzed: true,
    performanceMode: performanceMode() }), response => `已把 ${response.added} 个文件夹排进队列。`));
  q('clearQueue')?.addEventListener('click', () => act(() => post('/queue', {}, 'DELETE'), '已清空队列；正在分析的那个会继续。'));
  q('refreshLibrary')?.addEventListener('click', () => { state.notice = ''; void refresh(); });

  return {
    state, refresh,
    setVisible(visible) {
      state.visible = visible; state.notice = '';
      if (visible) void refresh(); else { clearTimer(timer); timer = null; }
    },
    reset() { version++; state.overview = null; state.expanded = null; render(); },
    dispose() { clearTimer(timer); version++; }
  };
}
