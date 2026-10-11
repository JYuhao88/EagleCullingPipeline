// Windows-only read-only discovery. Local config and all pixel artifacts stay on Windows.
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const supported = new Set(['jpg', 'jpeg', 'png', 'heic', 'arw', 'dng', '3fr', 'cr2', 'cr3', 'nef', 'raf']);
export async function inventory(library, { signal, onProgress = () => {} } = {}) {
  if (library.includes('未删减')) throw new Error('Protected library');
  const root = await read(path.join(library, 'metadata.json'));
  const folders = [], protectedIds = new Set();
  function visit(entries, protectedParent = false) {
    for (const folder of entries || []) {
      const protectedFolder = protectedParent || String(folder.name || '').includes('未删减');
      if (protectedFolder) protectedIds.add(folder.id);
      folders.push({ id: folder.id, hash: hash(folder.id), protected: protectedFolder,
        selectionLike: /精选|精選|精选集|selected|picks|best/i.test(folder.name || ''), count: 0 });
      visit(folder.children, protectedFolder);
    }
  }
  visit(root.folders);
  const folderMap = new Map(folders.map(folder => [folder.id, folder]));
  const items = [], ratingCounts = {}, extensionCounts = {};
  const summary = { scannedMetadata: 0, excludedProtected: 0, excludedDeleted: 0,
    comments: 0, tagged: 0, selectionLikeTags: 0, aiSelectedTags: 0, nonAiSelectionLikeTags: 0,
    selectionLikeFolders: folders.filter(f => f.selectionLike).length };
  const entries = await readdir(path.join(library, 'images'), { withFileTypes: true });
  let scanned = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (scanned++ % 64 === 0) onProgress({ stage: 'scanning', completed: scanned - 1, total: entries.length, cached: 0 });
    if (!entry.isDirectory() || !entry.name.endsWith('.info') || entry.name.includes('未删减')) continue;
    const directory = path.join(library, 'images', entry.name);
    let metadata;
    try { metadata = await read(path.join(directory, 'metadata.json')); } catch { continue; }
    summary.scannedMetadata++;
    if ((metadata.folders || []).some(id => protectedIds.has(id))) { summary.excludedProtected++; continue; }
    if (metadata.isDeleted || metadata.deleted || metadata.isTrash || metadata.inTrash) { summary.excludedDeleted++; continue; }
    const star = Number(metadata.star || 0), ext = String(metadata.ext || '').toLowerCase();
    ratingCounts[star] = (ratingCounts[star] || 0) + 1;
    extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
    summary.comments += Number(Boolean(metadata.annotation || metadata.comment));
    summary.tagged += Number(Boolean(metadata.tags?.length));
    summary.selectionLikeTags += Number((metadata.tags || []).some(tag => /精选|精選|selected|picks|best/i.test(tag)));
    summary.aiSelectedTags += Number((metadata.tags || []).includes('AI精选'));
    summary.nonAiSelectionLikeTags += Number((metadata.tags || []).some(tag =>
      /精选|精選|selected|picks|best/i.test(tag) && tag !== 'AI精选'));
    for (const id of metadata.folders || []) if (folderMap.has(id)) folderMap.get(id).count++;
    if (!supported.has(ext)) continue;
    const files = await readdir(directory);
    const original = files.find(name => name !== 'metadata.json' && !name.toLowerCase().includes('thumbnail')
      && path.extname(name).slice(1).toLowerCase() === ext && !name.includes('未删减'));
    if (!original) continue;
    const filePath = path.join(directory, original), fileStat = await stat(filePath);
    const thumbnail = files.find(name => name.toLowerCase().includes('thumbnail') && /\.(png|jpe?g)$/i.test(name));
    items.push({ ...metadata, id: metadata.id || entry.name.slice(0, -5), ext, filePath,
      size: fileStat.size, mtimeMs: fileStat.mtimeMs, fileStat: { size: fileStat.size, mtimeMs: fileStat.mtimeMs },
      thumbnailPath: thumbnail ? path.join(directory, thumbnail) : undefined });
  }
  return { items, folders, summary: { ...summary, ratingCounts, extensionCounts, supportedItems: items.length,
    folders: folders.filter(f => !f.protected).map(({ hash, count, selectionLike }) => ({ hash, count, selectionLike })) } };
}
if (process.argv[1]?.endsWith('windows-library.mjs')) {
  if (process.platform !== 'win32') throw new Error('Real library inspection stays on Windows');
  const config = await read(process.argv[2]);
  const out = path.resolve('data/cache/windows-validation');
  await mkdir(out, { recursive: true });
  const summaries = [];
  for (const [index, library] of config.libraries.entries()) {
    const { summary } = await inventory(library);
    summaries.push({ library: `library-${index + 1}`, ...summary });
  }
  await writeFile(path.join(out, 'library-inventory.json'), JSON.stringify(summaries, null, 2));
  console.log(JSON.stringify(summaries));
}
