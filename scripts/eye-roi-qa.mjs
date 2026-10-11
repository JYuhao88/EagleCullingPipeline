import path from 'node:path';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { completeEyeRois } from '../src/core/eye-roi.js';
import { focusRegionBox } from '../src/server/focus-image.js';
import { withNativeImage } from '../src/core/native-image.js';
import { analyzeFocus, readMakerFocus } from '../src/core/focus.js';
export async function eyeRoiQa(data, out = '/tmp/w10-eye-qa', poseFile = process.env.W10_POSE_CACHE || '/tmp/w1-pose-qa/all-results.json') {
  await mkdir(out, { recursive: true });
  const cached = JSON.parse(await readFile(poseFile, 'utf8'));
  const poses = new Map(cached.results.map(r => [r.unitId, r]));
  const rows = [], tiles = [], completedFocus = new Map();
  const ordered = [...data.results].sort((a, b) => a.unitId.localeCompare(b.unitId));
  const n = Math.min(80, ordered.length);
  const targets = Array.from({ length: n }, (_, i) => ordered[Math.floor(i * ordered.length / n)]);
  for (const [index, result] of targets.entries()) {
    const unit = data.units.find(u => u.id === result.unitId);
    const items = data.items.filter(i => unit.itemIds.includes(i.id));
    const primary = items.find(i => i.id === unit.primaryItemId);
    if (!primary || (primary.filePath || primary.path).includes('未删减')) throw new Error('Unsafe QA source');
    const pose = poses.get(result.unitId);
    // Require identical preview provenance before using cached upright points.
    const persons = pose?.previewPath === result.previewPath ? pose.signals?.persons || [] : result.signals?.persons || [];
    const before = result.faces || [], after = completeEyeRois(before, persons);
    const roi = faces => faces.some(f => focusRegionBox(f, 'eyes'));
    const row = { index: index + 1, unitId: result.unitId, beforeRoi: before.some(f => focusRegionBox(f, 'face')),
      afterRoi: after.some(f => focusRegionBox(f, 'face')),
      beforeExplicitRoi: roi(before), afterExplicitRoi: roi(after),
      poseCached: Boolean(persons.length), nativeBefore: false, nativeAfter: false,
      afBefore: null, afAfter: null };
    const makerFocus = await readMakerFocus(primary.filePath || primary.path);
    const start = performance.now();
    try {
      const native = await withNativeImage(primary, { pairedItems: items.filter(i => i !== primary) },
        async ({ image, source }) => {
          const buffer = await image().jpeg({ quality: 96 }).toBuffer();
          const nativeSize = { ...source };
          const old = await analyzeFocus({ nativeBuffer: buffer, nativeSize, faces: before, makerFocus });
          const next = await analyzeFocus({ nativeBuffer: buffer, nativeSize, faces: after, makerFocus });
          completedFocus.set(result.unitId, { ...next, nativeSize, source });
          row.eyeSharpnessBefore = old.eyeSharpnessNative; row.eyeSharpnessAfter = next.eyeSharpnessNative;
          row.nativeBefore = old.status === 'ok'; row.nativeAfter = next.status === 'ok';
          row.afBefore = old.afPointOnEye; row.afAfter = next.afPointOnEye;
          row.afSource = next.afSource; row.sourceKind = source.kind;
          return { available: true };
        });
      if (!native.available) row.error = native.naReason;
    } catch (error) { row.error = error.message; }
    row.elapsedMs = performance.now() - start; rows.push(row);
    const thumb = await sharp(result.previewPath).resize(320, 300, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
    const rects = after.map(f => focusRegionBox(f, 'eyes')).filter(Boolean).map(b =>
      `<rect x="${b[0] * thumb.info.width}" y="${b[1] * thumb.info.height}" width="${(b[2]-b[0])*thumb.info.width}"
        height="${(b[3]-b[1])*thumb.info.height}" fill="none" stroke="lime"/>`).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="340">${rects}
      <text x="5" y="325" fill="white" font-size="13">
      ${index+1}: ROI ${row.beforeRoi} → ${row.afterRoi}; AF ${row.afAfter}</text></svg>`);
    tiles.push(await sharp({ create: { width: 320, height: 340, channels: 3, background: '#222' } })
      .composite([{ input: thumb.data, top: 0, left: 0 }, { input: svg, top: 0, left: 0 }]).jpeg().toBuffer());
    console.log(`eye QA ${index+1}/${targets.length}`);
  }
  for (let i = 0; i < tiles.length; i += 20) await sharp({ create: { width: 1600, height: 1360, channels: 3,
    background: '#222' } }).composite(tiles.slice(i, i+20).map((input, n) => ({ input,
    left: n % 5 * 320, top: Math.floor(n / 5) * 340 }))).jpeg().toFile(path.join(out, `contact-${i / 20 + 1}.jpg`));
  const count = key => rows.filter(r => r[key]).length;
  const summary = { total: rows.length, beforeRoi: count('beforeRoi'), afterRoi: count('afterRoi'),
    beforeExplicitRoi: count('beforeExplicitRoi'), afterExplicitRoi: count('afterExplicitRoi'),
    nativeBefore: count('nativeBefore'), nativeAfter: count('nativeAfter'),
    afBefore: { known: rows.filter(r => r.afBefore !== null).length, hit: count('afBefore') },
    afAfter: { known: rows.filter(r => r.afAfter !== null).length, hit: count('afAfter') },
    errors: rows.filter(r => r.error).length,
    definition: 'Before: historical face-rectangle eye estimate; after: same plus RTMW landmarks. ' +
      'Explicit ROI counted separately. Native availability requires successful original decode and finite focus.',
    cache: 'Existing upright pose measurements; no inference', humanRoiAccuracy: '未完成：联系表待人工核对' };
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
  return { summary, completedFocus, completedFaces: new Map(targets.map(r => [r.unitId, completeEyeRois(r.faces,
    poses.get(r.unitId)?.previewPath === r.previewPath ? poses.get(r.unitId).signals?.persons : r.signals?.persons)])) };
}
