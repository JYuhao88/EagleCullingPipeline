import { metricsWithoutAestheticReference } from './aesthetic-head.js';
import { replaceFile } from './atomic-file.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FEATURE_SCHEMA_VERSION = 1;
export const NA = 'na';
export function validContentHash(hash) { return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash); }
export async function contentHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await replaceFile(temporary, file);
}
export class FeatureStore {
  constructor(root = 'data/learning') { this.root = root; this.dir = path.join(root, 'features', 'v1'); this.queue = Promise.resolve(); }
  file(hash) {
    if (!validContentHash(hash)) throw new Error('Invalid content SHA-256');
    return path.join(this.dir, hash.toLowerCase().slice(0, 2), `${hash.toLowerCase()}.json`);
  }
  async get(hash) {
    try { return JSON.parse(await readFile(this.file(hash), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  put(feature) {
    const operation = this.queue.then(async () => {
      const existing = await this.get(feature.hash);
      const contexts = [...(existing?.contexts || []), ...(feature.contexts || [])];
      const unique = [...new Map(contexts.map(context => [JSON.stringify(context), context])).values()];
      const value = { ...existing, ...feature, schemaVersion: FEATURE_SCHEMA_VERSION, contexts: unique };
      await atomicJson(this.file(feature.hash), value);
      return value;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async fromResult(result, { item = {}, unit = {}, group = {}, run = {} } = {}) {
    // Analysis SHA may describe a proxy. Only reuse it when that provenance is explicit.
    let hash = result.contentHash || (item.analysisSource === 'original' ? item.sha256 : null) ||
      (result.analysisSource === 'original' ? result.metrics?.sha256 : null);
    let kind = result.contentHashKind || 'original';
    const sourcePath = item.filePath || item.path;
    let originalAvailable = false;
    if (sourcePath) { try { await access(sourcePath); originalAvailable = true; } catch { /* Historical source may be deleted. */ } }
    if (!validContentHash(hash)) {
      try { hash = await contentHash(sourcePath); kind = 'original'; }
      catch {
        if (!result.previewPath) return null;
        try { hash = await contentHash(result.previewPath); kind = 'proxy'; } catch { return null; }
      }
    }
    const focus = result.signals?.focus ?? result.focus ?? result.metrics?.focus ?? NA;
    return this.put({ hash: hash.toLowerCase(), identity: { algorithm: 'sha256', kind },
      extractor: { version: result.extractorVersion || result.analysisVersion || 'legacy-unspecified',
        fingerprint: result.fingerprint || null, embedding: 'dinov2-mean-patch', scorer: result.scorer || NA },
      genre: result.genre || NA, genreProbabilities: result.genreProbabilities || NA,
      embedding: Array.isArray(result.embedding) ? result.embedding : NA,
      metrics: Object.fromEntries(Object.entries({ sharpness: NA, exposure: NA, eyesClosed: NA, quality: NA,
        aesthetic: NA, ...metricsWithoutAestheticReference(result), focus }).map(([key, value]) => [key, value == null ? NA : value])),
      signals: result.signals || NA,
      faces: { count: result.metrics?.faces ?? NA, eyesClosed: result.metrics?.eyesClosed ?? NA, items: result.faces || [] },
      exif: item.exif || result.exif || NA, captureTime: result.captureTime || item.captureTime || NA,
      availability: { original: originalAvailable, observedAt: new Date().toISOString() },
      contexts: [{ runId: run.id, groupId: group.id, unitId: result.unitId,
        itemIds: unit.itemIds || [item.id].filter(Boolean), libraryPath: run.libraryPath || null,
        candidateUnitIds: group.unitIds || [],
        baselineScore: group.ranking?.find(row => row.unitId === result.unitId)?.score ?? result.score ?? null }],
    });
  }
}
