#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ObservationRuntime, observationFace } from '../src/core/observation-runtime.js';
import { readManifest, readRow, readRows } from '../src/core/segmented-results.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIN_FACE_HEIGHT = .05;
const digest = value => createHash('sha256').update(value).digest('hex');
const photoId = unitId => `photo-${digest(unitId).slice(0, 12)}`;
const sameBox = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
const overlap = (a, b) => {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height / ((a[2] - a[0]) * (a[3] - a[1])) : 0;
};

function teacherFace(result) {
  const main = (result.signals?.persons || []).find(person => person.isMain);
  return (result.faces || []).filter(face => Array.isArray(face?.box)
    && (!main || overlap(face.box, main.box) > .5))
    .sort((a, b) => (b.box[3] - b.box[1]) - (a.box[3] - a.box[1]))[0] || null;
}

async function cleanCrop(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  // Removing only pHYs keeps compressed image data exact while stripping even harmless density metadata.
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8);
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND', 'pHYs'].includes(name) || length > bytes.length - offset - 12) return null;
    if (name !== 'pHYs') chunks.push(bytes.subarray(offset, offset + length + 12));
    offset += length + 12;
    if (name === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) return null;
  try {
    const meta = await sharp(bytes).metadata();
    const valid = meta.format === 'png' && meta.width === 384 && meta.height === 384
      && meta.channels === 3 && !meta.hasAlpha && !meta.hasProfile
      && !['exif', 'icc', 'iptc', 'xmp', 'comments', 'tifftagPhotoshop', 'orientation'].some(key => meta[key]);
    if (!valid) return null;
    const clean = Buffer.concat(chunks);
    const originalPixels = await sharp(bytes).raw().toBuffer(), cleanPixels = await sharp(clean).raw().toBuffer();
    if (!originalPixels.equals(cleanPixels)) return null;
    return { bytes: clean, cachedCropSha256: digest(bytes), cleanSha256: digest(clean), decodedRgbSha256: digest(cleanPixels) };
  } catch { return null; }
}

export async function recoverRuntimePhotos({ root = ROOT, runsDir = path.join(root, 'data/runs'),
  itemsFile = path.join(root, 'data/cache/observe/p0/items.jsonl'),
  cacheDir = path.join(root, 'data/cache/observations'), outputDir = path.join(root, 'data/cache/w33-gaze') } = {}) {
  const photos = (await readFile(itemsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.set === 'photos' && row.images?.face && (row.faceHeight || 0) >= MIN_FACE_HEIGHT);
  if (photos.some(row => !/^photo-[a-f0-9]{12}$/.test(row.id))
    || new Set(photos.map(row => row.id)).size !== photos.length) throw Error('Invalid photo cohort');
  const candidates = new Map(photos.map(row => [row.id, []]));
  const runtime = new ObservationRuntime([], { cacheDir: await realpath(cacheDir) });
  for (const run of (await readdir(runsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(runsDir, run.name), manifest = await readManifest(directory);
    if (!manifest || !['units', 'items', 'results'].every(kind => manifest.indexes?.[kind])) continue;
    const units = [];
    for await (const unit of readRows(directory, manifest, 'units')) {
      if (typeof unit.id === 'string' && candidates.has(photoId(unit.id))) units.push(unit);
    }
    if (!units.length) continue;
    const wanted = new Set(units.flatMap(unit => [unit.primaryItemId, ...(unit.itemIds || [])])), byId = new Map();
    for await (const item of readRows(directory, manifest, 'items')) if (wanted.has(item.id)) byId.set(item.id, item);
    for (const unit of units) {
      const id = photoId(unit.id), result = await readRow(directory, manifest, 'results', unit.id);
      if (!result) continue;
      const face = observationFace(result), teacher = teacherFace(result), faceBox = face?.box || null;
      const faceHeight = faceBox ? faceBox[3] - faceBox[1] : null;
      const candidate = { id, faceBox, faceHeight,
        minFaceHeightEligible: faceHeight !== null && faceHeight >= MIN_FACE_HEIGHT,
        subjectMismatch: !sameBox(faceBox, teacher?.box) };
      candidates.get(id).push(candidate);
      if (!face) { candidate.reason = teacher ? 'ambiguous-subject' : 'no-face'; continue; }
      if (candidate.subjectMismatch) { candidate.reason = 'subject-mismatch'; continue; }
      if (!candidate.minFaceHeightEligible) { candidate.reason = 'small-face'; continue; }
      if (!byId.has(unit.primaryItemId)) { candidate.reason = 'missing-record'; continue; }
      const record = { ...byId.get(unit.primaryItemId), unitId: unit.id, itemIds: unit.itemIds,
        pairedItems: (unit.itemIds || []).map(itemId => byId.get(itemId)).filter(Boolean) };
      // Empty heads make prepare stat-only: no model, crop generation, cache read or LRU touch.
      await runtime.prepare(result, record);
      const cropFile = runtime.plans.get(unit.id).cropFile;
      runtime.plans.delete(unit.id);
      let bytes;
      try { bytes = await readFile(cropFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; candidate.reason = 'missing-crop'; continue; }
      const clean = await cleanCrop(bytes);
      if (!clean) { candidate.reason = 'invalid-crop'; continue; }
      Object.assign(candidate, clean);
    }
  }
  await mkdir(path.join(outputDir, 'images/runtime-photos'), { recursive: true });
  const rows = [];
  for (const photo of photos) {
    const found = candidates.get(photo.id), available = new Map();
    for (const candidate of found.filter(row => row.bytes))
      available.set(JSON.stringify([candidate.faceBox, digest(candidate.bytes)]), candidate);
    const selected = available.values().next().value || found[0] || { id: photo.id, faceBox: null, faceHeight: null,
      minFaceHeightEligible: false, subjectMismatch: false, reason: 'missing-result' };
    const { bytes, ...row } = selected;
    if (available.size > 1) row.reason = 'multiple-runtime-crops';
    else if (bytes) {
      row.crop = `images/runtime-photos/${photo.id}.png`;
      row.file = row.crop;
      await writeFile(path.join(outputDir, row.crop), bytes);
    }
    row.box = row.faceBox;
    rows.push(row);
  }
  const counts = { requested: rows.length, recovered: rows.filter(row => row.crop).length, reasons: {} };
  counts.abstained = counts.requested - counts.recovered;
  for (const row of rows) if (row.reason) counts.reasons[row.reason] = (counts.reasons[row.reason] || 0) + 1;
  await writeFile(path.join(outputDir, 'runtime-photos.json'), JSON.stringify({ rows, counts }, null, 2) + '\n');
  return { rows, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify((await recoverRuntimePhotos()).counts)); }
  catch { console.error('Runtime crop recovery failed'); process.exitCode = 1; }
}
