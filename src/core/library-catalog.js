import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { analyzableExtension } from './metrics.js';

export const UNFILED = 'unfiled';

// Read-only view of an Eagle library's folder tree and which analyzable photos sit in which folder, taken from the
// library's own metadata files. Kept for `ttlMs`; an older copy is served while a fresh one is read.
export class LibraryCatalog {
  constructor({ ttlMs = 30000, now = () => Date.now(), concurrency = 16 } = {}) {
    this.ttlMs = ttlMs; this.now = now; this.concurrency = concurrency; this.libraries = new Map();
  }

  cached(libraryPath) { return this.libraries.get(libraryPath)?.value || null; }

  async get(libraryPath, { fresh = false } = {}) {
    let entry = this.libraries.get(libraryPath);
    const stale = !entry || fresh || this.now() - entry.readAt > this.ttlMs;
    if (stale && !entry?.loading) {
      const loading = read(libraryPath, this.concurrency).then(value => {
        this.libraries.set(libraryPath, { value, readAt: this.now() });
        while (this.libraries.size > 3) this.libraries.delete(this.libraries.keys().next().value);
        return value;
      }).catch(error => { const current = this.libraries.get(libraryPath); if (current) delete current.loading; throw error; });
      entry = { ...entry, loading };
      this.libraries.set(libraryPath, entry);
    }
    if (entry.value && !fresh) return entry.value;
    return entry.loading;
  }
}

async function read(libraryPath, concurrency) {
  const library = JSON.parse(await readFile(path.join(libraryPath, 'metadata.json'), 'utf8'));
  const folders = new Map(), roots = [];
  const walk = (list, parentId, into) => {
    for (const folder of Array.isArray(list) ? list : []) {
      if (typeof folder?.id !== 'string') continue;
      const node = { id: folder.id, name: String(folder.name || '未命名'), parentId, children: [] };
      folders.set(node.id, node); into.push(node);
      walk(folder.children, node.id, node.children);
    }
  };
  walk(library.folders, null, roots);
  const directories = (await readdir(path.join(libraryPath, 'images'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.info')).map(entry => entry.name);
  const items = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, directories.length) }, async () => {
    while (next < directories.length) {
      const name = directories[next++];
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(libraryPath, 'images', name, 'metadata.json'), 'utf8')); }
      catch { continue; }
      if (metadata.isDeleted || !analyzableExtension(metadata.ext)) continue;
      const id = metadata.id || name.replace(/\.info$/, '');
      items.set(id, { folders: (metadata.folders || []).filter(folderId => folders.has(folderId)) });
    }
  }));
  const members = new Map([[UNFILED, []]]);
  for (const [id, item] of items) {
    if (!item.folders.length) members.get(UNFILED).push(id);
    for (const folderId of item.folders) {
      if (!members.has(folderId)) members.set(folderId, []);
      members.get(folderId).push(id);
    }
  }
  return { roots, folders, items, members };
}

// One photo straight from the library folder, for views that need no analysis. Null for unknown, deleted or unusable items.
export async function readLibraryItem(libraryPath, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
  const dir = path.join(libraryPath, 'images', `${id}.info`);
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')); } catch { return null; }
  if (metadata.isDeleted || !analyzableExtension(metadata.ext)) return null;
  const files = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile());
  const original = files.find(entry => entry.name !== 'metadata.json' && !/thumbnail/i.test(entry.name));
  const thumbnail = files.find(entry => /thumbnail/i.test(entry.name));
  if (!original && !thumbnail) return null;
  const filePath = original ? path.join(dir, original.name) : null;
  const info = filePath ? await stat(filePath).catch(() => null) : null;
  return { id, name: metadata.name || original?.name || id, ext: String(metadata.ext || '').toLowerCase(), filePath,
    thumbnailPath: thumbnail ? path.join(dir, thumbnail.name) : null, width: metadata.width, height: metadata.height,
    mtimeMs: info?.mtimeMs || 0 };
}

// Photos a folder scope covers: only the folder's own photos, like Eagle's folder count; subfolders are their own scopes.
export function scopeItemIds(catalog, scope) {
  if (scope.type === 'unfiled') return catalog.members.get(UNFILED) || [];
  if (scope.type === 'folder') return catalog.members.get(scope.folderId) || [];
  return [];
}
