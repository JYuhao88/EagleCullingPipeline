import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIRS = ['../plugin', '../inspector'].map(dir => fileURLToPath(new URL(dir, import.meta.url)));

async function files(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return nested.flat();
}

// A short fingerprint of the plugin sources; open plugin pages reload themselves when it changes.
export function createPluginStamp({ dirs = PLUGIN_DIRS, maxAgeMs = 2000, now = Date.now } = {}) {
  let cached = null, at = 0, pending = null;
  return async function stamp() {
    if (cached && now() - at < maxAgeMs) return cached;
    pending ||= (async () => {
      const hash = createHash('sha1');
      for (const file of (await Promise.all(dirs.map(files))).flat().sort()) {
        try { const info = await stat(file); hash.update(`${file}:${info.size}:${info.mtimeMs}\n`); } catch { /* raced a delete */ }
      }
      cached = hash.digest('hex').slice(0, 12); at = now();
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
