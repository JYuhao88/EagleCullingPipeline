import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { embedImage } from '../../src/core/embeddings.js';

const directory = process.argv[2];
if (!directory) throw new Error('Fixture directory required');
const hash = createHash('sha256');
for await (const chunk of createReadStream(process.env.EAGLE_DINO_MODEL || 'models/dinov2-small/model.onnx')) hash.update(chunk);
const modelSha256 = hash.digest('hex');
if (modelSha256 !== '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea') {
  throw new Error('Local DINO checksum mismatch');
}
const remote = JSON.parse(await readFile(path.join(directory, 'remote-vectors.json'), 'utf8'));
const names = (await readdir(directory)).filter(name => name.endsWith('.jpg'));
if (names.length !== 20) throw new Error('Require 20 public AVA fixtures');
const rows = [];
for (const name of names) {
  const imagePath = path.join(directory, name);
  const embedding = await embedImage(imagePath, { cacheDir: path.join(directory, 'cache') });
  if (!embedding) throw new Error('Local DINO ONNX unavailable');
  const reference = remote[path.basename(name, '.jpg')];
  const cosine = embedding.reduce((sum, value, index) => sum + value * reference[index], 0)
    / Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0)
      * reference.reduce((sum, value) => sum + value * value, 0));
  const { data } = await sharp(imagePath).resize(256, 256, { fit: 'cover' })
    .extract({ left: 16, top: 16, width: 224, height: 224 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  await writeFile(path.join(directory, name.replace('.jpg', '.rgb')), data);
  rows.push({ id: path.basename(name, '.jpg'), cosine, embedding });
}
const report = { modelSha256, n: rows.length, cosine_min: Math.min(...rows.map(row => row.cosine)),
  cosine_mean: rows.reduce((sum, row) => sum + row.cosine, 0) / rows.length,
  pass: rows.every(row => row.cosine >= 0.999), rows };
await writeFile(path.join(directory, 'local-parity.json'), JSON.stringify(report));
console.log(JSON.stringify({ n: report.n, cosine_min: report.cosine_min, cosine_mean: report.cosine_mean, pass: report.pass }));
