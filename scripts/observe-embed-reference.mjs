import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import ort from 'onnxruntime-node';
import { embedImage } from '../src/core/embeddings.js';

const [itemsFile, p0Root] = process.argv.slice(2);
if (!itemsFile || !p0Root) throw new Error('Usage: observe-embed-reference.mjs <items.jsonl> <p0-root>');
const rows = (await readFile(itemsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const paths = [...new Set(rows.filter(row => row.images?.face).map(row => row.images.face))].sort().slice(0, 5);
if (paths.length !== 5) throw new Error('Need five p0 face images');
const clipPath = 'models/clip/vision_model_quantized.onnx';
const dinoPath = 'models/dinov2-small/model.onnx';
const sha256 = async file => {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
};
const session = await ort.InferenceSession.create(clipPath, { executionProviders: ['cpu'], intraOpNumThreads: 2,
  interOpNumThreads: 1, executionMode: 'sequential' });
const clip = async file => {
  const { data } = await sharp(file).rotate().resize(224, 224, { fit: 'cover', kernel: 'cubic' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mean = [0.48145466, 0.4578275, 0.40821073], std = [0.26862954, 0.26130258, 0.27577711];
  const input = new Float32Array(3 * 224 * 224);
  for (let index = 0; index < 224 * 224; index += 1) for (let channel = 0; channel < 3; channel += 1)
    input[channel * 224 * 224 + index] = (data[index * 3 + channel] / 255 - mean[channel]) / std[channel];
  const output = await session.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, 224, 224]) });
  return Array.from(output.image_embeds?.data ?? output[session.outputNames[0]].data);
};
const cacheDir = path.join(os.tmpdir(), 'w29-observe-parity');
const result = [];
for (const relative of paths) {
  const file = path.join(p0Root, relative);
  const { data: clipPixels } = await sharp(file).rotate().resize(224, 224, { fit: 'cover', kernel: 'cubic' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mean = [0.48145466, 0.4578275, 0.40821073], std = [0.26862954, 0.26130258, 0.27577711];
  const clipInput = new Float32Array(3 * 224 * 224);
  for (let index = 0; index < 224 * 224; index += 1) for (let channel = 0; channel < 3; channel += 1)
    clipInput[channel * 224 * 224 + index] = (clipPixels[3 * index + channel] / 255 - mean[channel]) / std[channel];
  result.push({ path: relative, clip: await clip(file), clipPixels: clipPixels.toString('base64'),
    clipTensor: Buffer.from(clipInput.buffer).toString('base64'),
    dino: await embedImage(file, { cacheDir, model: dinoPath }) });
}
console.log(JSON.stringify({ clipModelSha256: await sha256(clipPath), dinoModelSha256: await sha256(dinoPath), rows: result }));
