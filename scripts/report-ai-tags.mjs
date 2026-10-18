import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readManifest, readRows } from '../src/core/segmented-results.js';
import { deriveTags, sceneTags } from '../src/core/ai-tags.js';

const [runDirectory, outputDirectory] = process.argv.slice(2);
if (!runDirectory || !outputDirectory) throw new Error('用法：node scripts/report-ai-tags.mjs <任务目录> <报告目录>');
const manifest = await readManifest(runDirectory);
const data = { results: [], units: [], items: [] };
if (manifest) {
  for (const kind of Object.keys(data)) for await (const row of readRows(runDirectory, manifest, kind)) data[kind].push(row);
} else Object.assign(data, JSON.parse(await readFile(path.join(runDirectory, 'results.json'), 'utf8')));
const units = new Map(data.units.map(row => [row.id, row]));
const items = new Map(data.items.map(row => [row.id, row]));
const catalog = JSON.parse(await readFile(new URL('../src/core/scene-tags.json', import.meta.url), 'utf8'));
const rows = [], distribution = new Map();
const start = performance.now();
for (const result of data.results) {
  const unit = units.get(result.unitId), item = items.get(unit?.primaryItemId || unit?.itemIds?.[0]) || {};
  const before = performance.now();
  const tags = [...deriveTags(result, item), ...await sceneTags(result.previewPath, {
    fingerprint: result.fingerprint, cacheDir: path.join(outputDirectory, 'cache'),
  })];
  rows.push({ name: path.basename(result.sourcePath || result.previewPath || result.name || item.name || result.unitId),
    tags, elapsedMs: performance.now() - before });
  for (const { tag } of tags) distribution.set(tag, (distribution.get(tag) || 0) + 1);
  if (rows.length % 25 === 0) process.stdout.write(`已完成 ${rows.length}/${data.results.length}\n`);
}
const elapsed = performance.now() - start;
const orderedTimes = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
const stats = { count: rows.length, scenePhotos: rows.filter(row => row.tags.some(tag => tag.source === 'scene')).length,
  totalMs: elapsed, averageMs: elapsed / rows.length, firstMs: rows[0]?.elapsedMs,
  steadyAverageMs: rows.slice(1).reduce((sum, row) => sum + row.elapsedMs, 0) / Math.max(1, rows.length - 1),
  p95Ms: orderedTimes[Math.floor(orderedTimes.length * 0.95)] };
const samples = Array.from({ length: Math.min(10, rows.length) }, (_, i) => rows[Math.floor(i * (rows.length - 1) / 9)]);
const distributionRows = [...distribution].sort((a, b) => b[1] - a[1]);
const report = [
  '# 本机 AI 标签只读验证', '',
  `模型：${catalog.model}；版本：${catalog.version}；CPU 2 线程。`,
  '只读任务与预览；只在报告目录生成标签缓存，未调用 Eagle。首次运行包含模型初始化和冷缓存。', '',
  `共 ${stats.count} 个单元；场景标签覆盖 ${stats.scenePhotos} 张。`,
  `总耗时 ${(elapsed / 1000).toFixed(2)} 秒；平均 ${stats.averageMs.toFixed(2)} ms/张；`,
  `首张 ${stats.firstMs.toFixed(2)} ms；去首张平均 ${stats.steadyAverageMs.toFixed(2)} ms；P95 ${stats.p95Ms.toFixed(2)} ms。`,
  '', '## 标签分布', '', '| 标签 | 照片数 |', '| --- | ---: |',
  ...distributionRows.map(([tag, count]) => `| ${tag} | ${count} |`),
  '', '## 10 个等距抽样', '', '| 文件名 | 标签 |', '| --- | --- |',
  ...samples.map(row => `| ${row.name.replaceAll('|', '\\|')} | ${row.tags.map(tag => tag.tag).join('、')} |`), '',
].join('\n');
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'report.md'), report);
await writeFile(path.join(outputDirectory, 'tags.json'), JSON.stringify({ stats, distribution: distributionRows, rows }, null, 2));
process.stdout.write(JSON.stringify(stats) + '\n');
