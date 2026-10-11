// Deliberately constructed workflow fixture, not an image-quality benchmark.
// Unique proxy bytes prevent content identities leaking across temporal holdouts.
import path from 'node:path';
import { createRequire } from 'node:module';
const rankingConfig = createRequire(import.meta.url)('../src/core/ranking-weights.json');
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rankGroup, suggestDecision, gateFlags } from '../src/core/ranking.js';
export async function strongFixture(root, source, config) {
  const data = { run: { ...source.run, id: 'run-w8-strong' }, units: [], items: [], results: [], groups: [] };
  const template = source.results.find(r => r.unitId === 'unit:tsyn:s001') || source.results[0];
  const proxy = await readFile(template.previewPath);
  await mkdir(path.join(root, 'strong-photos'), { recursive: true });
  const count = config.trainingGroups + config.stableGroups + config.switchedGroups + config.holdoutGroups;
  for (let i = 0; i < count; i++) {
    const rows = [];
    const guards = i >= count - config.holdoutGroups;
    for (const variant of guards ? ['neutral', 'bright', 'dark', 'closed', 'blurred'] : ['neutral', 'bright', 'dark']) {
      const id = `strong-${String(i).padStart(4, '0')}-${variant}`;
      const bytes = Buffer.concat([proxy, Buffer.from(`\nW8 synthetic identity ${id}\n`)]);
      const file = path.join(root, 'strong-photos', `${id}.jpg`);
      await writeFile(file, bytes);
      const dark = !['bright', 'neutral'].includes(variant), neutral = variant === 'neutral';
      const metrics = { ...(template.metrics || {}),
        sharpness: variant === 'blurred' ? rankingConfig.gates.sharpnessBelow / 10 : 0.8, exposure: 0.8,
        quality: neutral ? 0.95 : dark ? 0.4 : 0.65, aesthetic: 0.5, faces: 1,
        eyesClosed: variant === 'closed' ? 1 : 0, cropTightness: neutral ? 0.5 : dark ? 0.8 : 0.2,
        clippedHighlights: 0, clippedShadows: 0, faceClippedHighlights: 0, faceClippedShadows: 0,
        raw: { meanLuma: neutral ? 125 + i % 10 : dark ? 65 + i % 10 : 180 + i % 10 } };
      // Scalar-only legacy eye measurements are intentional, explicitly synthetic.
      const result = { unitId: id, metrics, genre: 'portrait', previewPath: file,
        contentHash: createHash('sha256').update(bytes).digest('hex'), contentHashKind: 'proxy',
        fixtureSourceFingerprint: template.fingerprint || null,
        fingerprint: `w8-constructed-features-v1:${id}`, scorer: 'synthetic-workflow-fixture', flags: [] };
      result.flags = gateFlags(result);
      data.items.push({ id, name: id, ext: 'jpg', path: file, filePath: file, tags: [] });
      data.units.push({ id, primaryItemId: id, itemIds: [id], formats: ['jpg'], contractVersion: 1 });
      data.results.push(result); rows.push(result);
    }
    const ranking = rankGroup(rows);
    data.groups.push({ id: `group-strong-${String(i).padStart(4, '0')}`, contractVersion: 1,
      unitIds: rows.map(r => r.unitId), ranking,
      suggested: Object.fromEntries(ranking.map(r => [r.unitId, 
        suggestDecision(r, rows.find(x => x.unitId === r.unitId), rows.length)])) });
  }
  return data;
}
