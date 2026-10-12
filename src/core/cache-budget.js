import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, unlink, utimes, readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { replaceFile } from './atomic-file.js';

export const GB = 1024 ** 3;
export const DEFAULT_MAX_BYTES = 5 * GB;
export const CACHE_CATEGORIES = [
  ['previews', '预览', 0], ['native-mid', '中间图', 0], ['focus-crops', '裁剪', 0],
  ['embeddings', '特征', 1], ['focus', '对焦', 1], ['results-v2', '分析结果', 2],
  // Counted only: a single index file whose loss forces a full-library EXIF rescan, and the shared legacy journal.
  ['capture-metadata', '拍摄信息', 3], ['results.jsonl', '旧版结果（只读）', 3],
];
export async function touchCache(file) {
  const now = new Date();
  try { await utimes(file, now, now); } catch { /* LRU must never fail analysis. */ }
}

async function walk(file, rows, signal) {
  signal?.throwIfAborted();
  await yieldTurn();
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Never follow symlinks into originals, models, runs or other libraries.
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of await readdir(file)) await walk(path.join(file, name), rows, signal);
  } else if (info.isFile()) rows.push({ file, bytes: info.size, mtime: info.mtimeMs });
}
async function inventory(cacheRoot, signal) {
  const rows = [], categories = [];
  for (const [name, label, priority] of CACHE_CATEGORIES) {
    const files = [];
    await walk(path.join(path.resolve(cacheRoot), name), files, signal);
    rows.push(...files.map(row => ({ ...row, name, priority })));
    categories.push({ name, label, bytes: files.reduce((sum, row) => sum + row.bytes, 0), files: files.length });
  }
  return { rows, categories, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
}
export async function cacheUsage(cacheRoot, { signal } = {}) {
  const { categories, totalBytes } = await inventory(cacheRoot, signal);
  return { totalBytes, categories };
}
export async function readCacheLimit(cacheRoot) {
  try {
    const { maxBytes } = JSON.parse(await readFile(path.join(cacheRoot, 'cache-settings.json'), 'utf8'));
    if (Number.isSafeInteger(maxBytes) && maxBytes >= GB && maxBytes <= 200 * GB) return maxBytes;
  } catch { /* Default on missing or corrupt settings. */ }
  return DEFAULT_MAX_BYTES;
}
export async function writeCacheLimit(cacheRoot, maxBytes) {
  const file = path.join(cacheRoot, 'cache-settings.json'), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(temporary, JSON.stringify({ maxBytes }), { flag: 'wx' });
  const handle = await open(temporary, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await replaceFile(temporary, file);
}
function protectedFiles(protect) {
  const files = new Set(Array.isArray(protect) || protect instanceof Set ? protect : protect?.files || []);
  for (const fingerprint of protect?.fingerprints || []) {
    files.add(createHash('sha256').update(fingerprint).digest('hex') + '.json');
  }
  return files;
}
export async function enforceCacheBudget({ cacheRoot, maxBytes = DEFAULT_MAX_BYTES, protect = {}, signal,
  now = Date.now(), scope } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid cache budget');
  const snapshot = await inventory(cacheRoot, signal);
  if (!scope && snapshot.totalBytes <= maxBytes) return { ...await cacheUsage(cacheRoot), deleted: [] };
  const protectedSet = protectedFiles(protect), groups = new Map();
  for (const row of snapshot.rows) {
    if (row.priority === 3 || scope === 'derived' && row.priority !== 0) continue;
    // Preview and native sidecars are a single eviction unit, even if one is orphaned.
    const key = row.priority === 0 ? row.file.replace(/\.json$/, '') : row.file;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [...groups.values()].sort((a, b) => a[0].priority - b[0].priority ||
    Math.max(...a.map(row => row.mtime)) - Math.max(...b.map(row => row.mtime)) || a[0].file.localeCompare(b[0].file));
  let remaining = snapshot.totalBytes;
  const target = maxBytes * .9, deleted = [];
  for (const group of candidates) {
    if (!scope && remaining <= target) break;
    signal?.throwIfAborted();
    await yieldTurn();
    if (group.some(row => protectedSet.has(row.file) || protectedSet.has(path.basename(row.file)) ||
      !scope && row.mtime > now - 24 * 60 * 60 * 1000)) continue;
    // Recheck touches performed during the scan. Delete sidecar first: interrupted deletion is a safe cache miss.
    let changed = false;
    for (const row of group) {
      const info = await lstat(row.file).catch(() => null);
      if (info && (info.isSymbolicLink() || info.mtimeMs !== row.mtime || info.size !== row.bytes)) changed = true;
    }
    if (changed) continue;
    for (const row of group.sort((a, b) => Number(b.file.endsWith('.json')) - Number(a.file.endsWith('.json')))) {
      signal?.throwIfAborted();
      try { await unlink(row.file); remaining -= row.bytes; deleted.push(row.file); }
      catch (error) { if (error.code !== 'ENOENT') continue; }
    }
  }
  return { ...await cacheUsage(cacheRoot, { signal }), deleted };
}

export function createCacheMaintenance({ cacheRoot, isBusy, getProtect = async () => ({}),
  now = Date.now, throttleMs = 600000 } = {}) {
  let pending = null, controller, last = -Infinity, timer;
  const trigger = () => {
    if (pending || isBusy() || now() - last < throttleMs) return pending || Promise.resolve();
    controller = new AbortController();
    pending = (async () => {
      const maxBytes = await readCacheLimit(cacheRoot), protect = await getProtect();
      controller.signal.throwIfAborted();
      if (isBusy()) return;
      last = now();
      return await enforceCacheBudget({ cacheRoot, maxBytes, protect, signal: controller.signal });
    })().catch(() => {}).finally(() => { pending = null; });
    return pending;
  };
  return { trigger, start() { timer = setTimeout(trigger, 60000); timer.unref?.(); },
    async cancel() { controller?.abort(); await pending; },
    async dispose() { clearTimeout(timer); controller?.abort(); await pending; } };
}
