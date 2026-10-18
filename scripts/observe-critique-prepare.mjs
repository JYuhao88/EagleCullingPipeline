#!/usr/bin/env node
// Offline, read-only inputs: reuse the exact reference derivatives and persisted heads.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ruleObservations } from '../src/core/observations-rules.js';
import { readManifest, readRows } from '../src/core/segmented-results.js';
import { relativePath, readJsonl } from './observe-vlm-prepare.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const RULE_IDS = new Set(['background-person', 'multiple-people', 'face-front', 'face-side', 'hand-near-face', 'eyes-closed']);
const MODEL_TEXT = { smile: '在笑', mouth: '嘴张开', gaze: '看镜头' };
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export const headsVersion = heads => `observations-v1-${digest(JSON.stringify(heads.map(head =>
  [head.version, digest(JSON.stringify(head))])))}`;

export function specialistFacts(row, heads) {
  const rules = ruleObservations(row).filter(item => RULE_IDS.has(item.id));
  const persisted = row.observations?.version === headsVersion(heads) ? row.observations.items : [];
  const learned = (persisted || []).filter(item => {
    const head = heads.find(value => value.attributes.some(attribute => attribute.id === item.id));
    const attribute = head?.attributes.find(value => value.id === item.id);
    return item.source === 'model' && item.text === MODEL_TEXT[item.id] && attribute
      && Number.isFinite(item.confidence) && item.confidence >= attribute.showThreshold
      && item.confidence <= 1;
  });
  return [...rules, ...learned].map(({ id, text, source, box, confidence }) => ({ id, text, source,
    ...(box ? { box } : {}), ...(confidence == null ? {} : { confidence }) }));
}

export function selectCorpus(rows, openImages = 200) {
  if (!Number.isInteger(openImages) || openImages < 0 || openImages > 200) throw new Error('Open Images limit must be 0..200');
  const photos = rows.filter(row => row.set === 'photos' && !row.kind);
  const publicRows = rows.filter(row => row.set === 'openimages' && !row.kind)
    .sort((a, b) => digest(`critique-v1|${a.id}`).localeCompare(digest(`critique-v1|${b.id}`))).slice(0, openImages);
  const selected = [...photos, ...publicRows];
  if (publicRows.length !== openImages || new Set(selected.map(row => row.id)).size !== selected.length) {
    throw new Error('incomplete or duplicate reference corpus');
  }
  return selected;
}

export async function validateDerivative(file) {
  const bytes = await readFile(file), meta = await sharp(bytes).metadata();
  if (meta.format !== 'jpeg' || !meta.width || !meta.height || Math.max(meta.width, meta.height) > 768
    || meta.exif || meta.xmp || meta.iptc || meta.icc || meta.hasProfile || meta.hasAlpha) throw new Error('unsafe reference derivative');
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('invalid JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if ([0xda, 0xd9].includes(marker)) break;
    if ([0xe1, 0xe2, 0xed, 0xfe].includes(marker)) throw new Error('reference derivative contains metadata');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('invalid JPEG segment');
    offset += length;
  }
  return { sha256: digest(bytes), bytes: bytes.length, width: meta.width, height: meta.height };
}

export async function prepareCritique({ prepared = path.join(ROOT, 'data/cache/w34-vlm/prepared'), run,
  output = path.join(ROOT, 'data/cache/w36-vlm-critique/prepared'), openImages = 200, expectedPhotos = 291 } = {}) {
  if (!run) throw new Error('explicit analysis run required');
  await mkdir(path.join(ROOT, 'data/cache/w36-vlm-critique'), { recursive: true });
  const cacheRoot = await realpath(path.join(ROOT, 'data/cache/w36-vlm-critique'));
  const resolvedOut = path.resolve(output);
  const parent = await realpath(path.dirname(resolvedOut)).catch(() => path.dirname(resolvedOut));
  if (parent !== cacheRoot && !parent.startsWith(cacheRoot + path.sep)) throw new Error('output outside own line cache');
  // An exclusive directory prevents pre-existing links from redirecting any output writes.
  await mkdir(output);
  if (!(await realpath(output)).startsWith(cacheRoot + path.sep)) throw new Error('output outside own line cache');
  const headFiles = ['clip-face-v1.json', 'gaze-iris-q2-clip-v1.json'].map(name => path.join(ROOT, 'src/core/observation-heads', name));
  const heads = await Promise.all(headFiles.map(json));
  const manifest = await readManifest(run);
  if (!manifest) throw new Error('segmented analysis required');
  const byPhoto = new Map();
  for await (const row of readRows(run, manifest, 'results')) byPhoto.set(`photo-${digest(row.unitId).slice(0, 12)}`, row);
  const inputs = selectCorpus(await readJsonl(path.join(prepared, 'manifest.jsonl')), openImages);
  if (inputs.filter(row => row.set === 'photos').length !== expectedPhotos) throw new Error('photo count differs from frozen corpus');
  const rows = [], stats = [];
  for (const input of inputs) {
    const full = relativePath(input.images.full, { jpeg: true });
    const row = { id: input.id, set: input.set, images: { full }, storage: input.storage, specialist_facts: [] };
    if (input.storage === 'package') {
      const source = await realpath(path.join(prepared, full));
      if (!source.startsWith(await realpath(prepared) + path.sep)) throw new Error('reference escapes prepared root');
      const stat = await validateDerivative(source);
      row.images.full = `images/${stat.sha256}.jpg`;
      await mkdir(path.join(output, 'images'), { recursive: true });
      await copyFile(source, path.join(output, row.images.full));
      if (digest(await readFile(path.join(output, row.images.full))) !== stat.sha256) throw new Error('derivative copy changed');
      stats.push({ id: input.id, ...stat });
      const result = byPhoto.get(input.id);
      if (!result) throw new Error('photo missing from explicit analysis run');
      row.specialist_facts = specialistFacts(result, heads);
      row.facts_source = { run_manifest_sha256: digest(await readFile(path.join(run, 'results-index.json'))),
        observations_version: result.observations?.version || null };
    } else if (input.storage === 'ceph') row.imageRoot = relativePath(input.imageRoot);
    else throw new Error('unknown reference storage');
    row.variants = row.set === 'photos' || row.specialist_facts.length ? ['A', 'B'] : ['A'];
    rows.push(row);
  }
  const bytes = rows.map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(path.join(output, 'manifest.jsonl'), bytes);
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(rows, null, 2) + '\n');
  const summary = { manifest_sha256: digest(bytes), photos: rows.filter(row => row.set === 'photos').length,
    openimages: rows.filter(row => row.set === 'openimages').length,
    photos_with_facts: rows.filter(row => row.specialist_facts.length).length,
    facts: rows.reduce((n, row) => n + row.specialist_facts.length, 0),
    fact_counts: Object.fromEntries([...RULE_IDS, ...Object.keys(MODEL_TEXT)].map(id => [id,
      rows.reduce((n, row) => n + row.specialist_facts.filter(fact => fact.id === id).length, 0)])),
    asks_per_model: rows.reduce((n, row) => n + row.variants.length * 2, 0),
    source_manifest_sha256: digest(await readFile(path.join(prepared, 'manifest.jsonl'))),
    source_run_manifest_sha256: digest(await readFile(path.join(run, 'results-index.json'))),
    head_sha256: await Promise.all(headFiles.map(async file => ({ name: path.basename(file), sha256: digest(await readFile(file)) }))),
    rule_source_sha256: digest(await readFile(path.join(ROOT, 'src/core/observations-rules.js'))), images: stats };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--prepared', '--run', '--output', '--open-images'].includes(key) || !value) throw new Error('invalid option');
    args[key === '--open-images' ? 'openImages' : key.slice(2)] = key === '--open-images' ? Number(value) : value;
  }
  prepareCritique(args).then(({ images, ...summary }) => console.log(JSON.stringify(summary, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
