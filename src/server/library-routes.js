import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceFile } from '../core/atomic-file.js';
import { LibraryCatalog, UNFILED, scopeItemIds } from '../core/library-catalog.js';
import { scopeKey } from '../core/task-continuity.js';
import { json, parseBody } from './http.js';

const UNFILED_LABEL = '未归入文件夹';
const MAX_SELECT = 2000;

// Analyses waiting to run, oldest first. Folder entries keep only the folder: its photos are read when it starts.
export class AnalysisQueue {
  constructor(file = null) { this.file = file; this.entries = null; this.loading = null; }
  async list() {
    if (this.entries) return this.entries;
    this.loading ||= (async () => {
      try { this.entries = this.file ? JSON.parse(await readFile(this.file, 'utf8')).entries || [] : []; }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.entries = []; }
      return this.entries;
    })();
    return this.loading;
  }
  size() { return this.entries?.length || 0; }
  async save() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8');
    await replaceFile(temporary, this.file);
  }
  async add(entry) {
    const entries = await this.list();
    const existing = entries.find(row => row.libraryPath === entry.libraryPath && row.key === entry.key);
    if (existing) return { entry: existing, added: false };
    const row = { id: `q-${randomUUID()}`, queuedAt: new Date().toISOString(), ...entry };
    entries.push(row); await this.save();
    return { entry: row, added: true };
  }
  async remove(id) {
    const entries = await this.list(), index = entries.findIndex(row => row.id === id);
    if (index < 0) return null;
    const [row] = entries.splice(index, 1); await this.save();
    return row;
  }
  async unshift(row) { (await this.list()).unshift(row); await this.save(); }
  async top(id) { const row = await this.remove(id); if (row) await this.unshift(row); return row; }
  async clear(libraryPath) {
    const entries = await this.list(), before = entries.length;
    this.entries = entries.filter(row => row.libraryPath !== libraryPath); await this.save();
    return before - this.entries.length;
  }
}

const scopeKeyOf = scope => scope.type === 'folder' ? `folder:${scope.folderId}` : scope.type === 'unfiled' ? UNFILED : null;

function folderLabel(catalog, folderId) {
  const names = [];
  for (let folder = catalog.folders.get(folderId); folder; folder = catalog.folders.get(folder.parentId)) names.unshift(folder.name);
  return names.join(' › ') || '未命名';
}

export function createLibraryRouter({ store, index, active = { run: null }, startRun, isUpdating = () => false,
  catalog = new LibraryCatalog(), queue = new AnalysisQueue(store?.root ? path.join(store.root, 'analysis-queue.json') : null) }) {
  void queue.list().catch(() => {});
  const running = libraryPath => {
    const run = active.run;
    if (!run || run.purpose === 'prefetch' || run.libraryPath !== libraryPath) return null;
    return { runId: run.id, key: scopeKeyOf(run.scope || {}), label: run.scope?.label || '分析中',
      percent: run.progress?.overallPercent ?? null };
  };

  async function queueView(libraryPath) {
    return (await queue.list()).filter(row => row.libraryPath === libraryPath)
      .map((row, i) => ({ id: row.id, label: row.label, type: row.scope.type, position: i + 1,
        ...(row.scope.folderId ? { folderId: row.scope.folderId } : {}),
        ...(row.scope.itemIds ? { count: row.scope.itemIds.length } : {}) }));
  }

  // Coverage of one scope: how many of its photos are analyzed, and whether it is queued or running.
  function scopeStat(libraryPath, ids, analyzed, positions, key) {
    const run = running(libraryPath);
    return { count: ids.length, analyzed: ids.reduce((n, id) => n + (analyzed.has(id) ? 1 : 0), 0),
      queued: positions.get(key) ?? null, running: run && run.key === key ? run.percent ?? 0 : null };
  }

  async function coverage(libraryPath, options) {
    const [library, analyzed, entries] = await Promise.all([catalog.get(libraryPath, options), index.items(libraryPath),
      queueView(libraryPath)]);
    const positions = new Map(entries.filter(row => row.type !== 'selection')
      .map(row => [row.type === 'folder' ? `folder:${row.folderId}` : UNFILED, row.position]));
    return { library, analyzed, entries, positions };
  }

  async function overview(libraryPath) {
    const { library, analyzed, entries, positions } = await coverage(libraryPath);
    const node = folder => {
      const own = scopeStat(libraryPath, library.members.get(folder.id) || [], analyzed, positions, `folder:${folder.id}`);
      const children = folder.children.map(node);
      const subtree = children.reduce((sum, child) => ({ count: sum.count + child.subtree.count,
        analyzed: sum.analyzed + child.subtree.analyzed }), { count: own.count, analyzed: own.analyzed });
      return { id: folder.id, name: folder.name, ...own, subtree, children };
    };
    let analyzedTotal = 0;
    for (const id of library.items.keys()) if (analyzed.has(id)) analyzedTotal++;
    const run = running(libraryPath);
    return { libraryPath, total: library.items.size, analyzed: analyzedTotal, folders: library.roots.map(node),
      unfiled: scopeStat(libraryPath, library.members.get(UNFILED) || [], analyzed, positions, UNFILED),
      queue: entries, active: run && { runId: run.runId, label: run.label, percent: run.percent } };
  }

  // Where the selected photos (or the folders selected in Eagle's sidebar) live, and how far each place is analyzed.
  async function locate(libraryPath, itemIds, folderIds) {
    let state = await coverage(libraryPath);
    if (itemIds.some(id => !state.library.items.has(id))) state = await coverage(libraryPath, { fresh: true });
    const { library, analyzed, positions } = state;
    const keys = new Set();
    if (folderIds.length) for (const id of folderIds) { if (library.folders.has(id)) keys.add(`folder:${id}`); }
    else for (const id of itemIds) {
      const item = library.items.get(id);
      if (!item) continue;
      if (!item.folders.length) keys.add(UNFILED);
      for (const folderId of item.folders) keys.add(`folder:${folderId}`);
    }
    const scopes = [...keys].map(key => {
      const folderId = key.startsWith('folder:') ? key.slice(7) : null;
      const ids = folderId ? library.members.get(folderId) || [] : library.members.get(UNFILED) || [];
      return { type: folderId ? 'folder' : 'unfiled', ...(folderId ? { folderId } : {}),
        label: folderId ? folderLabel(library, folderId) : UNFILED_LABEL, ...scopeStat(libraryPath, ids, analyzed, positions, key) };
    });
    return { scopes, selected: { total: itemIds.length, analyzed: itemIds.filter(id => analyzed.has(id)).length },
      queueLength: (await queueView(libraryPath)).length, active: running(libraryPath) };
  }

  async function entryFor(libraryPath, scope, performanceMode) {
    if (scope?.type === 'selection') {
      const ids = [...new Set(scope.itemIds)];
      return { libraryPath, key: scopeKey({ type: 'selection' }, ids), label: `选中的 ${ids.length} 张`,
        scope: { type: 'selection', itemIds: ids }, performanceMode };
    }
    const library = await catalog.get(libraryPath);
    if (scope?.type === 'unfiled') return { libraryPath, key: UNFILED, label: UNFILED_LABEL, scope: { type: 'unfiled' }, performanceMode };
    if (scope?.type === 'folder' && library.folders.has(scope.folderId)) {
      return { libraryPath, key: `folder:${scope.folderId}`, label: folderLabel(library, scope.folderId),
        scope: { type: 'folder', folderId: scope.folderId }, performanceMode };
    }
    throw new Error('找不到这个文件夹，可能已在 Eagle 中删除');
  }

  // What POST /runs receives when an entry starts; folder photos are read now, so later imports are included.
  async function requestFor(entry) {
    const scope = { type: entry.scope.type, label: entry.label, ...(entry.scope.folderId ? { folderId: entry.scope.folderId } : {}) };
    const itemIds = entry.scope.type === 'selection' ? entry.scope.itemIds
      : scopeItemIds(await catalog.get(entry.libraryPath, { fresh: true }), entry.scope);
    return { libraryPath: entry.libraryPath, scope, itemIds, performanceMode: entry.performanceMode || 'normal' };
  }

  let draining = null;
  const busy = () => Boolean(active.run && active.run.purpose !== 'prefetch');
  // Starts the next entry when nothing else runs. Entries whose photos are gone are dropped.
  async function startNext() {
    while (!busy() && !isUpdating()) {
      const [entry] = await queue.list();
      if (!entry) return null;
      await queue.remove(entry.id);
      let request;
      try { request = await requestFor(entry); } catch { continue; }
      if (!request.itemIds.length) continue;
      const [status, payload] = await startRun(request);
      if (status === 202) return payload;
      if (status === 409) { await queue.unshift(entry); return null; }
    }
    return null;
  }
  // A request that arrives while one is in flight (say, the running analysis just finished) runs again afterwards.
  let again = false;
  function drain() {
    if (draining) { again = true; return draining; }
    draining = startNext().finally(() => {
      draining = null;
      if (again) { again = false; void drain().catch(() => {}); }
    });
    return draining;
  }

  // For the inspector: an unanalyzed photo's place in the queue, from the catalog already in memory.
  function waiting(libraryPath, itemId) {
    const library = catalog.cached(libraryPath);
    if (!library) { void catalog.get(libraryPath).catch(() => {}); return null; }
    const item = library.items.get(itemId);
    if (!item) return null;
    const keys = item.folders.length ? item.folders.map(id => `folder:${id}`) : [UNFILED];
    const run = running(libraryPath);
    if (run && keys.includes(run.key)) return { analyzing: true, label: run.label, percent: run.percent };
    const entries = (queue.entries || []).filter(row => row.libraryPath === libraryPath);
    const at = entries.findIndex(row => keys.includes(row.key) || row.scope.itemIds?.includes(itemId));
    return at < 0 ? null : { position: at + 1, label: entries[at].label };
  }

  async function route(req, res, url) {
    if (!url.pathname.startsWith('/library/') && !url.pathname.startsWith('/queue')) return false;
    const body = ['POST', 'DELETE'].includes(req.method) ? await parseBody(req).catch(() => ({})) : {};
    const libraryPath = url.searchParams.get('libraryPath') || body.libraryPath;
    if (typeof libraryPath !== 'string' || !/\.library[\\/]?$/.test(libraryPath)) return json(res, 400, { error: '需要 Eagle 资源库路径' });
    try {
      if (req.method === 'GET' && url.pathname === '/library/overview') return json(res, 200, await overview(libraryPath));
      if (req.method === 'POST' && url.pathname === '/library/selection') {
        const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter(id => typeof id === 'string').slice(0, 50000) : [];
        const folderIds = Array.isArray(body.folderIds) ? body.folderIds.filter(id => typeof id === 'string').slice(0, 200) : [];
        return json(res, 200, await locate(libraryPath, itemIds, folderIds));
      }
      if (req.method === 'GET' && url.pathname === '/library/unanalyzed') {
        const { library, analyzed } = await coverage(libraryPath, { fresh: true });
        const scope = url.searchParams.get('unfiled') === '1' ? { type: 'unfiled' }
          : { type: 'folder', folderId: url.searchParams.get('folderId') };
        const ids = scopeItemIds(library, scope).filter(id => !analyzed.has(id));
        return json(res, 200, { total: ids.length, itemIds: ids.slice(0, MAX_SELECT) });
      }
      if (req.method === 'GET' && url.pathname === '/queue') {
        return json(res, 200, { queue: await queueView(libraryPath), active: running(libraryPath) });
      }
      if (req.method === 'POST' && url.pathname === '/queue') {
        const mode = body.performanceMode === 'turbo' ? 'turbo' : 'normal';
        let scopes = Array.isArray(body.scopes) ? body.scopes.slice(0, 500) : [];
        if (body.allUnanalyzed === true) {
          const view = await overview(libraryPath), wanted = [];
          const visit = folder => { if (folder.analyzed < folder.count) wanted.push({ type: 'folder', folderId: folder.id });
            folder.children.forEach(visit); };
          view.folders.forEach(visit);
          if (view.unfiled.analyzed < view.unfiled.count) wanted.push({ type: 'unfiled' });
          scopes = wanted;
        }
        for (const scope of scopes) if (scope?.type === 'selection' && (!Array.isArray(scope.itemIds) || !scope.itemIds.length ||
          scope.itemIds.length > 50000 || !scope.itemIds.every(id => typeof id === 'string'))) return json(res, 400, { error: '选中的照片无效' });
        let added = 0;
        for (const scope of scopes) if ((await queue.add(await entryFor(libraryPath, scope, mode))).added) added++;
        const started = await drain();
        return json(res, 200, { added, started, queue: await queueView(libraryPath), active: running(libraryPath) });
      }
      if (req.method === 'DELETE' && url.pathname === '/queue') {
        return json(res, 200, { removed: await queue.clear(libraryPath), queue: [] });
      }
      const match = url.pathname.match(/^\/queue\/(q-[a-zA-Z0-9-]+)(\/top)?$/);
      if (match && req.method === 'DELETE' && !match[2]) await queue.remove(match[1]);
      else if (match && req.method === 'POST' && match[2]) await queue.top(match[1]);
      else return json(res, 404, { error: 'not found' });
      return json(res, 200, { queue: await queueView(libraryPath), active: running(libraryPath) });
    } catch (error) {
      return json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '读不到这个资源库' : error.message });
    }
  }
  return { route, drain, waiting, queue, catalog };
}
