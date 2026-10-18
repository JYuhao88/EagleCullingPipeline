import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sceneTags } from '../src/core/ai-tags.js';

const work = await mkdtemp(path.join(os.tmpdir(), 'eagle-clip-check-'));
const skimage = 'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/';
const samples = [
  { file: 'cat.png', url: `${skimage}chelsea.png`, expected: '猫' },
  { file: 'dog.jpg', url: 'https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg', expected: '狗' },
  { file: 'coffee.png', url: `${skimage}coffee.png`, expected: '美食；允许漏标' },
  { file: 'astronaut.png', url: `${skimage}astronaut.png`, expected: '人像；允许漏标' },
  { file: 'rocket.jpg', url: `${skimage}rocket.jpg`, expected: '词表外，空' },
  { file: 'white.png', color: 'white', expected: '空' },
  { file: 'black.png', color: 'black', expected: '空' },
  { file: 'gray.png', color: '#808080', expected: '空' },
];
try {
  const catalog = JSON.parse(await readFile(new URL('../src/core/scene-tags.json', import.meta.url), 'utf8'));
  console.log('| 样例 | 预期 | 最相似标签（余弦） | 通过阈值 |');
  console.log('| --- | --- | --- | --- |');
  for (const sample of samples) {
    const file = path.join(work, sample.file);
    if (sample.url) {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error(`公开样例下载失败：${sample.file} HTTP ${response.status}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
    } else {
      await sharp({ create: { width: 224, height: 224, channels: 3, background: sample.color } }).png().toFile(file);
    }
    const opts = { cacheDir: path.join(work, 'cache') };
    const tags = await sceneTags(file, opts);
    const top = await sceneTags(file, { ...opts,
      catalog: { ...catalog, labels: catalog.labels.map(label => ({ ...label, threshold: 0 })) } });
    if (!top.length) throw new Error('场景模型未运行，请先运行 node scripts/download-clip.mjs');
    const best = `${top[0].tag} (${top[0].score.toFixed(4)})`;
    console.log(`| ${sample.file} | ${sample.expected} | ${best} | ${tags.map(row => row.tag).join('、') || '空'} |`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
