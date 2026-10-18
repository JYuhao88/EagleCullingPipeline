#!/usr/bin/env node
// Face-crop CLIP features computed by the same Node code path the inspector's observation stage uses, so heads
// are accepted on the runtime's numbers rather than on the Python training features (quantized CLIP differs slightly).
//
//   node scripts/observe-node-features.mjs <name>   writes data/cache/observe/<name>/node-clip-face.json
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clipImageVector } from '../src/core/ai-tags.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MODEL = path.join(ROOT, 'models/clip/vision_model_quantized.onnx');

export async function nodeFeatures(name, { dir = path.join(ROOT, 'data/cache/observe', name), model = MODEL,
  infer = clipImageVector } = {}) {
  const items = (await readFile(path.join(dir, 'items.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ids = [], features = [];
  for (const item of items.filter(row => row.images?.face)) {
    const vector = await infer(path.join(dir, item.images.face), model, {});
    const norm = Math.hypot(...vector);
    if (!norm) continue;
    ids.push(item.id);
    features.push(Array.from(vector, value => +(value / norm).toFixed(7)));
  }
  const modelSha256 = createHash('sha256').update(await readFile(model)).digest('hex');
  await writeFile(path.join(dir, 'node-clip-face.json'), JSON.stringify({ encoder: 'clip-b32-q', modelSha256, ids, features }));
  return { items: ids.length, modelSha256 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('usage: observe-node-features.mjs <name>'); process.exit(2); }
  console.log(JSON.stringify(await nodeFeatures(process.argv[2])));
}
