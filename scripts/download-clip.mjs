import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const revision = 'd15189d7028b43f1d3e65039190477f6af591c2a';
const base = `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/${revision}/`;
const assets = [
  { remote: 'onnx/vision_model_quantized.onnx', file: 'models/clip/vision_model_quantized.onnx',
    sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' },
];
const textIndex = process.argv.indexOf('--text-assets');
if (textIndex >= 0) {
  const target = process.argv[textIndex + 1];
  if (!target) throw new Error('--text-assets 后需要临时目录');
  assets.push(
    { remote: 'onnx/text_model.onnx', file: path.join(target, 'text_model.onnx'),
      sha256: '3f6571f5bad13a97c469c1622e1cfc4d9aef78b79fdbfcff804ca357bfada8cc' },
    { remote: 'tokenizer.json', file: path.join(target, 'tokenizer.json'),
      sha256: 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd' },
  );
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
for (const asset of assets) {
  try {
    await access(asset.file);
    if (await hash(asset.file) === asset.sha256) {
      console.log(`校验通过：${path.basename(asset.file)}`);
      continue;
    }
  } catch {}
  await mkdir(path.dirname(asset.file), { recursive: true });
  const partial = `${asset.file}.download`;
  try {
    const response = await fetch(base + asset.remote);
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (await hash(partial) !== asset.sha256) throw new Error(`SHA-256 不匹配：${path.basename(asset.file)}`);
    await rename(partial, asset.file);
    console.log(`下载并校验完成：${path.basename(asset.file)}`);
  } finally {
    await rm(partial, { force: true });
  }
}
