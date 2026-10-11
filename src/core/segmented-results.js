import { replaceFile } from './atomic-file.js';
import path from 'node:path';
import { mkdir, open, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

// Publish immutable generations with one atomic manifest replacement. Readers
// holding an older manifest remain valid while another process saves a run.
export async function writeSegmented(directory, data) {
  const generation = `results-${randomUUID()}`;
  const folder = path.join(directory, generation);
  await mkdir(folder, { recursive: true });
  const manifest = { storageVersion: 1, generation, indexes: {}, groups: [], analysisSignature: '' };
  const signature = createHash('sha256');
  const flags = new Map();
  for (const kind of ['units', 'results', 'items', 'groups']) {
    const index = Object.create(null);
    let shard = 0, offset = 0, handle;
    try {
      for await (const row of data[kind] || []) {
        const bytes = Buffer.from(JSON.stringify(row) + '\n');
        if (!handle || offset + bytes.length > 16 * 1024 ** 2) {
          await handle?.close();
          handle = await open(path.join(folder, `${kind}-${shard++}.jsonl`), 'wx');
          offset = 0;
        }
        const key = kind === 'results' ? row.unitId || row.id : row.id;
        index[key] = [shard - 1, offset, bytes.length];
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!bytesWritten) throw new Error('Unable to write result shard');
          written += bytesWritten;
        }
        offset += bytes.length;
        if (kind === 'results') {
          signature.update(JSON.stringify([key, row.fingerprint || null]));
          flags.set(key, row.flags || []);
        }
        if (kind === 'groups') manifest.groups.push({ id: key, unitIds: row.unitIds,
          confidence: row.confidence, margin: row.margin,
          flags: [...new Set(row.unitIds.flatMap(id => flags.get(id) || []))] });
      }
    } finally { await handle?.close(); }
    manifest.indexes[kind] = index;
  }
  manifest.analysisSignature = signature.digest('hex');
  if (data.duplicateCandidates) {
    const file = await open(path.join(folder, 'duplicates.json'), 'wx');
    try { await file.writeFile(JSON.stringify(data.duplicateCandidates)); } finally { await file.close(); }
  }
  const temporary = path.join(directory, `results-index.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  try { await file.writeFile(JSON.stringify(manifest)); } finally { await file.close(); }
  await replaceFile(temporary, path.join(directory, 'results-index.json'));
  return manifest;
}

export async function readManifest(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'results-index.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readRow(directory, manifest, kind, key) {
  const index = manifest.indexes[kind];
  const location = index && Object.hasOwn(index, key) ? index[key] : null;
  if (!location) return null;
  const [shard, offset, length] = location;
  const handle = await open(path.join(directory, manifest.generation, `${kind}-${shard}.jsonl`), 'r');
  try {
    const bytes = Buffer.alloc(length);
    let completed = 0;
    while (completed < length) {
      const { bytesRead } = await handle.read(bytes, completed, length - completed, offset + completed);
      if (!bytesRead) throw new Error('Truncated result shard');
      completed += bytesRead;
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}

export async function* readRows(directory, manifest, kind) {
  for (const key of Object.keys(manifest.indexes[kind])) yield await readRow(directory, manifest, kind, key);
}
