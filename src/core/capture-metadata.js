import { execFile } from 'node:child_process';
import path from 'node:path';
import { CaptureMetadataCache, captureFileIdentity, captureMetadataKey } from './capture-metadata-cache.js';
import { localSetting } from './local-config.js';

/** EXIF wall time without an offset is kept on a synthetic UTC timeline.
 * offset:null distinguishes that convention from a known UTC capture. */
export function parseCaptureMetadata(row = {}) {
  const original = row.SubSecDateTimeOriginal || row.DateTimeOriginal;
  const match = String(original || '')
    .match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  let captureTime = null, offset = null, subsec = null, localDate = null;
  if (match) {
    const [, year, month, day, hour, minute, second, fraction, zone] = match;
    subsec = fraction || String(row.SubSecTimeOriginal || '').replace(/\D/g, '') || null;
    const rawOffset = zone || row.OffsetTimeOriginal;
    offset = rawOffset === 'Z' ? '+00:00' : /^[+-]\d{2}:?\d{2}$/.test(rawOffset || '')
      ? String(rawOffset).replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : null;
    localDate = `${year}-${month}-${day}`;
    const wall = `${localDate}T${hour}:${minute}:${second}.${(subsec || '').padEnd(3, '0').slice(0, 3)}`;
    const ms = Date.parse(`${wall}${offset || 'Z'}`);
    // Reject normalized dates such as February 31 and invalid offset hours.
    const calendar = new Date(`${wall}Z`);
    if (Number.isFinite(ms) && !Number.isNaN(calendar.valueOf()) &&
        calendar.toISOString().slice(0, 19) === wall.slice(0, 19)) captureTime = new Date(ms).toISOString();
  }
  const device = Object.fromEntries([
    ['make', row.Make], ['model', row.Model],
    ['serial', row.SerialNumber || row.BodySerialNumber],
  ].filter(([, value]) => value != null && String(value).trim()).map(([key, value]) => [key, String(value).trim()]));
  return { captureTime, exif: { dateTimeOriginal: row.DateTimeOriginal || null,
    subSecTimeOriginal: subsec, offsetTimeOriginal: offset, localDate: captureTime ? localDate : null },
    device: Object.keys(device).length ? device : null };
}

export function runExiftool(paths, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(localSetting('EAGLE_EXIFTOOL', 'exiftool'),
      ['-json', '-DateTimeOriginal', '-SubSecDateTimeOriginal',
      '-SubSecTimeOriginal', '-OffsetTimeOriginal', '-Make', '-Model', '-SerialNumber',
      '-BodySerialNumber', ...(process.platform === 'win32' ? ['-charset', 'filename=UTF8'] : []), '-@', '-'],
    { maxBuffer: 4 * 1024 * 1024, timeout: 30_000, signal },
    (error, stdout) => {
      // exiftool may return 1 for one unreadable file alongside valid rows.
      try { resolve(JSON.parse(stdout)); } catch { reject(error || new Error('Invalid EXIF response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(paths.join('\n') + '\n');
  });
}

/** Serial bounded batches avoid argv/output growth and concurrent RAW readers. */
export async function enrichCaptureMetadata(records, {
  batchSize = 128, reader = runExiftool, signal, checkpoint, onProgress = () => {}, metadataCache,
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be positive');
  const candidates = records.filter(record => record.filePath && !/[\r\n]/.test(record.filePath));
  // Custom readers (tests, alternative tools) must opt in, so their output never lands in the shared cache.
  const enabled = metadataCache === undefined ? reader === runExiftool : metadataCache !== false;
  const cache = enabled ? await (metadataCache || new CaptureMetadataCache()).load() : null;
  const pending = [], identities = new Map();
  let cached = 0;
  onProgress({ stage: 'scanning', phase: 'capture-metadata', completed: 0, total: candidates.length, cached });
  for (const record of candidates) {
    signal?.throwIfAborted();
    const info = cache ? await captureFileIdentity(record.filePath) : null;
    const key = info ? captureMetadataKey(record.filePath, info) : null;
    identities.set(record, key);
    const value = key ? cache.get(key) : null;
    if (value) {
      Object.assign(record, value);
      if (checkpoint) await checkpoint.put(`scan:${record.id}`, record);
      cached++;
      onProgress({ stage: 'scanning', phase: 'capture-metadata', completed: cached, total: candidates.length, cached });
    } else pending.push(record);
  }
  let completed = cached;
  try {
    for (let start = 0; start < pending.length; start += batchSize) {
      signal?.throwIfAborted();
      const batch = pending.slice(start, start + batchSize);
      try {
        const rows = await reader(batch.map(record => record.filePath), { signal });
        signal?.throwIfAborted();
        const sourceKey = value => process.platform === 'win32' && typeof value === 'string'
          ? path.win32.resolve(value).toLowerCase() : value;
        const byPath = new Map(rows.map(row => [sourceKey(row.SourceFile), row]));
        for (const record of batch) {
          const row = byPath.get(sourceKey(record.filePath));
          if (!row) continue;
          const value = parseCaptureMetadata(row);
          Object.assign(record, value);
          const key = identities.get(record);
          const after = key ? await captureFileIdentity(record.filePath) : null;
          if (!row.Error && after && captureMetadataKey(record.filePath, after) === key) cache.put(key, value);
        }
      } catch { signal?.throwIfAborted(); /* Missing EXIF preserves legacy grouping. */ }
      if (checkpoint) for (const record of batch) await checkpoint.put(`scan:${record.id}`, record);
      completed += batch.length;
      onProgress({ stage: 'scanning', phase: 'capture-metadata', completed, total: candidates.length, cached });
    }
  } finally { await cache?.flush(); }
  assignCaptureSessions(records);
  return records;
}

/** Session boundaries use capture time, never import timestamps or folder ids. */
export function assignCaptureSessions(records, { gapMs = 30 * 60 * 1000 } = {}) {
  const buckets = new Map();
  const millis = value => typeof value === 'number' ? value : Date.parse(value);
  for (const record of records) {
    const time = millis(record.captureTime);
    if (record.sessionId || !Number.isFinite(time)) continue;
    const device = record.device || {};
    const key = JSON.stringify([device.make || '', device.model || '', device.serial || '',
      record.exif?.offsetTimeOriginal || '', record.exif?.localDate || new Date(time).toISOString().slice(0, 10)]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  for (const [key, members] of buckets) {
    members.sort((a, b) => millis(a.captureTime) - millis(b.captureTime) || String(a.id).localeCompare(String(b.id)));
    let previous = -Infinity, session;
    for (const record of members) {
      const time = millis(record.captureTime);
      if (time - previous > gapMs) session = `capture:${key}:${new Date(time).toISOString()}`;
      record.sessionId = session;
      previous = time;
    }
  }
  return records;
}
