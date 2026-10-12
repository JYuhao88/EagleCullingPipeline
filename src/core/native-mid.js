import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, stat, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { localSetting } from './local-config.js';
import { replaceFile } from './atomic-file.js';
import { nativeFingerprint, normalizedRect, withNativeImage } from './native-image.js';

function setting(name, fallback, min, max) {
  const value = Number(localSetting(name, String(fallback)));
  return Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
}
export function midSettings(options = {}) {
  return { edge: options.edge ?? setting('EAGLE_NATIVE_MID_EDGE', 6144, 512, 8192),
    quality: options.quality ?? setting('EAGLE_NATIVE_MID_QUALITY', 96, 80, 100),
    maxBytes: options.maxBytes ?? setting('EAGLE_NATIVE_MID_MAX_BYTES', 2 * 1024 ** 3, 0, 32 * 1024 ** 3),
    cacheDir: path.resolve(options.cacheDir || 'data/cache/native-mid') };
}
export async function midKey(record, options = {}) {
  const { edge, quality } = midSettings(options);
  return crypto.createHash('sha256').update(JSON.stringify(['native-mid-v1',
    await nativeFingerprint(record, options.pairedItems || record.pairedItems || []), edge, quality,
    localSetting('EAGLE_EXIFTOOL'), localSetting('EAGLE_PYTHON')])).digest('hex');
}

// Metadata publishes last; incomplete JPEGs are never visible as hits.
export async function readMid(record, options = {}) {
  const settings = midSettings(options), key = await midKey(record, options);
  if (!settings.maxBytes) return null;
  const file = path.join(settings.cacheDir, `${key}.jpg`);
  try {
    const metadata = JSON.parse(await readFile(`${file}.json`, 'utf8'));
    const info = await stat(file);
    if (!info.size || metadata.bytes !== info.size ||
      ![metadata.width, metadata.height, metadata.source?.width, metadata.source?.height]
        .every(v => Number.isInteger(v) && v > 0)) return null;
    await utimes(file, new Date(), new Date());
    return { ...metadata, path: file, cached: true };
  } catch { return null; }
}

let cleanup = Promise.resolve();
export function trimMidCache(dir, maxBytes) {
  const operation = cleanup.catch(() => {}).then(async () => {
    const entries = [];
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9]{64}\.jpg$/.test(name)) continue;
      try {
        const info = await stat(path.join(dir, name));
        const metadata = await stat(path.join(dir, `${name}.json`)).catch(() => ({ size: 0 }));
        entries.push({ name, size: info.size + metadata.size, mtimeMs: info.mtimeMs });
      } catch { /* concurrent eviction */ }
    }
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (bytes <= maxBytes) break;
      // Unpublish first so a racing reader falls back to original.
      await rm(path.join(dir, `${entry.name}.json`), { force: true });
      await rm(path.join(dir, entry.name), { force: true });
      bytes -= entry.size;
    }
  });
  cleanup = operation;
  return operation;
}

// Prefetch calls are globally serial even if foreground native concurrency is raised.
let prefetchTail = Promise.resolve();
export function prefetchMid(record, options = {}) {
  const operation = prefetchTail.catch(() => {}).then(async () => {
    options.signal?.throwIfAborted();
    if (options.isBusy?.()) return { available: false, naReason: 'analysis-busy' };
    const settings = midSettings(options);
    const hit = await readMid(record, options);
    if (hit) {
      await trimMidCache(settings.cacheDir, settings.maxBytes);
      if (!await stat(hit.path).catch(() => null)) return { available: false, naReason: 'cache-limit' };
      return { available: true, ...hit };
    }
    if (!settings.maxBytes) return { available: false, naReason: 'cache-disabled' };
    const key = await midKey(record, options), file = path.join(settings.cacheDir, `${key}.jpg`);
    await mkdir(settings.cacheDir, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let published = false;
    try {
      const result = await withNativeImage(record, { ...options, background: true }, async ({ image, source }) => {
        const info = await image().resize({ width: settings.edge, height: settings.edge,
          fit: 'inside', withoutEnlargement: true }).jpeg({ quality: settings.quality,
          chromaSubsampling: '4:4:4' }).toFile(temporary);
        options.signal?.throwIfAborted();
        const metadata = { available: true, source, width: info.width, height: info.height, bytes: info.size };
        await writeFile(`${temporary}.json`, JSON.stringify(metadata));
        options.signal?.throwIfAborted();
        await replaceFile(temporary, file);
        published = true;
        options.signal?.throwIfAborted();
        await replaceFile(`${temporary}.json`, `${file}.json`);
        return { ...metadata, path: file, cached: false };
      });
      options.signal?.throwIfAborted();
      await trimMidCache(settings.cacheDir, settings.maxBytes);
      if (result.available && !await stat(result.path).catch(() => null)) {
        return { available: false, naReason: 'cache-limit' };
      }
      return result;
    } finally {
      if (published && options.signal?.aborted) {
        await rm(`${file}.json`, { force: true }); await rm(file, { force: true });
      }
      await rm(temporary, { force: true }); await rm(`${temporary}.json`, { force: true });
    }
  });
  prefetchTail = operation.catch(() => {});
  return operation;
}

export function midCovers(mid, box, display) {
  if (!mid || !normalizedRect(box, 1, 1) || !display ||
    ![display.width, display.height].every(v => Number.isInteger(v) && v > 0 && v <= 8192)) return false;
  const bw = box[2] - box[0], bh = box[3] - box[1];
  // Keep near 1:1 on original pixels, including sources smaller than the configured edge.
  return display.width <= bw * mid.width && display.height <= bh * mid.height &&
    display.width < bw * mid.source.width * 0.9 && display.height < bh * mid.source.height * 0.9;
}
export async function midRegion(record, box, display, options = {}) {
  options.signal?.throwIfAborted();
  const mid = await readMid(record, options);
  if (!midCovers(mid, box, display)) return null;
  try {
    const rect = normalizedRect(box, mid.width, mid.height);
    const buffer = await sharp(mid.path).extract(rect).resize(display.width, display.height, { fit: 'fill' })
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
    options.signal?.throwIfAborted();
    return { available: true, buffer, source: mid.source, rect: { width: display.width, height: display.height }, tier: 'mid' };
  } catch (error) { options.signal?.throwIfAborted(); return null; }
}
