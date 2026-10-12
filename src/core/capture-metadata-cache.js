import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { replaceFile } from './atomic-file.js';

// Bump whenever parseCaptureMetadata output or its interpretation changes.
export const CAPTURE_PARSER_VERSION = 'capture-v1';
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../../data/cache/capture-metadata/', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

export function normalizeCapturePath(file, platform = process.platform) {
  return platform === 'win32' ? path.win32.resolve(file).toLowerCase() : path.resolve(file);
}

export function captureMetadataKey(file, info, platform = process.platform) {
  return digest(JSON.stringify([normalizeCapturePath(file, platform), info.size, info.mtimeMs]));
}

export async function captureFileIdentity(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch { return null; }
}

function validValue(value) {
  const nullableString = x => x === null || typeof x === 'string';
  return value && Object.keys(value).sort().join(',') === 'captureTime,device,exif' &&
    nullableString(value.captureTime) && value.exif &&
    Object.keys(value.exif).sort().join(',') === 'dateTimeOriginal,localDate,offsetTimeOriginal,subSecTimeOriginal' &&
    Object.values(value.exif).every(nullableString) &&
    (value.device === null || (typeof value.device === 'object' && !Array.isArray(value.device) &&
      Object.entries(value.device).every(([key, item]) => ['make', 'model', 'serial'].includes(key) && typeof item === 'string')));
}

/** Best-effort derived cache; failures never replace successful EXIF reads.
 * Concurrent processes can lose cache additions, but never publish partial JSON. */
export class CaptureMetadataCache {
  constructor({ directory = DEFAULT_DIRECTORY, version = CAPTURE_PARSER_VERSION,
    maxEntries = 20_000, maxBytes = 32 * 1024 * 1024 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Cache limits must be positive integers');
    }
    this.file = path.join(directory, 'metadata.json');
    this.version = version;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.dirty = false;
  }

  async load() {
    this.entries = new Map();
    this.dirty = false;
    try {
      if ((await stat(this.file)).size > this.maxBytes) return this;
      const document = JSON.parse(await readFile(this.file, 'utf8'));
      if (document.version !== this.version || !Array.isArray(document.entries) ||
          document.entries.length > this.maxEntries || digest(JSON.stringify(document.entries)) !== document.sha256) return this;
      if (!document.entries.every(entry => Array.isArray(entry) && entry.length === 2 &&
          /^[a-f0-9]{64}$/.test(entry[0]) && validValue(entry[1]))) return this;
      this.entries = new Map(document.entries);
    } catch { /* Missing, corrupt or unreadable cache is a miss. */ }
    return this;
  }

  get(key) {
    const value = this.entries.get(key);
    return value ? structuredClone(value) : null;
  }

  put(key, value) {
    if (!validValue(value)) return;
    this.entries.delete(key);
    this.entries.set(key, structuredClone(value));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      let entries = [...this.entries];
      const serialize = () => JSON.stringify({ version: this.version, entries, sha256: digest(JSON.stringify(entries)) });
      let content = serialize();
      while (Buffer.byteLength(content) > this.maxBytes && entries.length) {
        entries = entries.slice(Math.max(1, Math.ceil(entries.length / 10)));
        content = serialize();
      }
      if (Buffer.byteLength(content) > this.maxBytes) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, content, { flag: 'wx' });
      await replaceFile(temporary, this.file);
      this.entries = new Map(entries);
      this.dirty = false;
    } catch { /* Disk full/permissions must not fail the scan. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
