import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { analyzeImage, normalizeMetrics } from '../src/core/metrics.js';
import { score } from '../src/core/scorer.js';
import { detectFaces } from '../src/core/faces.js';
import { detectPose } from '../src/core/pose.js';
import { computeSignals } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';
import { evaluateSynthetic, evaluateTriage, evaluateCandidateSensitivity, compareSynthetic } from '../ml/bench/evaluate.mjs';
import { analyzeFocus } from '../src/core/focus.js';

const ROOT = path.resolve('data/cache/bench');
const SYN = path.resolve('test/fixtures/bench-syn-manifest.json');
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const pct = value => value == null ? '不可用' : `${(value * 100).toFixed(2)}%`;
const ci = value => value?.low == null ? '不可用' : `[${pct(value.low)}, ${pct(value.high)}]`;

export function markdown(report) {
  const syn = report.synthetic, triage = report.triage;
  const lines = ['# mac-ray-dev 评测基线', '', `时间：${report.createdAt}；分支：${report.branch}；HEAD：${report.commit}`, '',
    '使用现有 analyzeImage / TOPIQ / faces / pose / signals / rules / rankGroup / suggestDecision 函数；不修改评分。',
    '固定按基准的 pair/series 排序，绕过相似分组与 embedding；这是评分基准，不是全流程分组验收。', '',
    `T-syn：${syn.sourceCount} 源图、${syn.pairs} 对；偏好准确率 ${pct(syn.accuracy)}，95% CI ${ci(syn.ci)}。`,
    `源图误淘汰（保留先验代理指标）${syn.sourceFalseReject.hits}/${syn.sourceCount} = ${pct(syn.sourceFalseReject.rate)}` +
      `，bootstrap CI ${ci(syn.sourceFalseReject.ci)}。`,
    `应淘汰退化图 gate 命中 ${syn.gate.hits}/${syn.gate.total} = ${pct(syn.gate.rate)}。`,
    '源图误淘汰按独立单张 suggestDecision 计算，每张只计一次；不能据此宣称全库误删 ≤2%。',
    '零误拒的小样本 bootstrap 会退化为 [0,0]，不能解读为总体误拒为零。', '',
    '| 退化 | 对数 | 偏好准确率（同分不算正确） | 应淘汰 gate 命中 |', '|---|---:|---:|---:|'];
  for (const [type, row] of Object.entries(syn.byDegradation)) {
    lines.push(`| ${type} | ${row.pairs} | ${pct(row.accuracy)} | ${row.gate.hits}/${row.gate.total} (${pct(row.gate.rate)}) |`);
  }
  lines.push('', 'gate 以受控两图组实际 suggestDecision 的 rejected 为准；单张 serious-flag 检查另存 JSON。',
    '裁切等规则 verdict 不自动改成拒绝：当前 pipeline 尚未把这些 verdict 接入 ranking/gate。',
    `随机偏好基线 50%；源图/退化对的生成顺序没有拍摄时间含义。`, '',
    `T-triage：${triage.status}；组数 ${triage.groups}。`);
  if (triage.status === 'completed') {
    lines.push(`top-1 ${pct(triage.top1.rate)}，95% CI ${ci(triage.top1.ci)}；` +
      `strong pair ${pct(triage.pairwise.rate)}，95% CI ${ci(triage.pairwise.ci)}。`,
    `随机 top-1 ${pct(triage.random.top1.rate)} / pair ${pct(triage.random.pairwise.rate)}；` +
      `时间顺序 top-1 ${pct(triage.chronological.top1.rate)} / pair ${pct(triage.chronological.pairwise.rate)}。`);
  } else lines.push(`原因：${triage.reason}；top-1、成对准确率与 CI 均为 null。`);
  lines.push('', 'bootstrap：固定 seed=42，1000 次，T-syn 按源图聚类、T-triage 按连拍组重采样。',
    'W5 附加类别为测量敏感性；对照仅在 SHA256 一致的既有 pair 上计算。', '', '模型警告：', '',
    ...(report.warnings.length ? report.warnings.map(w => `- ${w}`) : ['- 无']), '',
    '运行：`nice -n 10 node scripts/bench.mjs`（请求并发 1，TOPIQ 线程 2；本次依赖设置见 ml/bench/README.md）。', '');
  if (report.baselineSynthetic) {
    const b = report.baselineSynthetic;
    lines.push('', `既有固定 ${b.pairs} 对回放：${pct(b.accuracy)}；严重档 gate ${pct(b.gate.rate)}；` +
      `源图误淘汰 ${b.sourceFalseReject.hits}/${b.sourceCount}。`);
  }
  if (report.candidateSensitivity) {
    lines.push('', 'W5 连续测量敏感性（源图人物几何与 TOPIQ 固定复用；不是审美真值）', '',
      '| 类别 | 可测 / 对数 | 偏好敏感性 | 同分 | 提示可判定对数 |', '|---|---:|---:|---:|---:|');
    for (const [name,row] of Object.entries(report.candidateSensitivity.byDegradation))
      lines.push(`| ${name} | ${row.covered}/${row.pairs} | ${pct(row.accuracy)} | ${row.ties} | ${row.policyEligible} |`);
    lines.push('', '可测连续量与提示判定覆盖分开统计；高 TOPIQ 等保护可以使提示为 na，'
      + '但不删除原始像素测量。新增类别默认排序使用冻结源图模型输出，'
      + '不能作为新图完整模型评分结果。');
  }
  if (report.comparison) lines.push(`与指定报告比较：${JSON.stringify(report.comparison)}`, '');
  return lines.join('\n');
}
async function analysisSignature() {
  const files = ['metrics.js', 'scorer.js', 'ranking.js', 'ranking-weights.json', 'faces.js', 'pose.js', 'signals.js', 'rules-engine.js',
    'candidate-measurements.js', 'candidate-config.json'];
  const chunks = await Promise.all(files.map(file => readFile(path.join('src/core', file))));
  for (const file of ['portrait', 'landscape', 'street']) chunks.push(await readFile(`src/rules/${file}.json`));
  for (const file of ['pose_worker.py', 'face_worker.py']) chunks.push(await readFile(`python_worker/${file}`));
  chunks.push(Buffer.from(JSON.stringify([process.env.EAGLE_PYTHON, process.env.PYTHONPATH, process.env.EAGLE_POSE_MODE,
    process.env.EAGLE_POSE_PROVIDER, process.env.EAGLE_POSE_MODEL, process.env.EAGLE_POSE_DETECTOR])));
  return hash(Buffer.concat(chunks));
}
async function analyze(images, directory, warnings, signature) {
  const results = new Array(images.length), pending = [];
  for (const [i, image] of images.entries()) {
    const file = path.resolve(directory, image.path);
    if (!file.startsWith(`${directory}${path.sep}`) || file.includes('未删减')) throw new Error('Unsafe benchmark path');
    const digest = hash(await readFile(file));
    if (image.sha256 && digest !== image.sha256) throw new Error(`Image checksum mismatch: ${image.id}`);
    const cache = path.join(ROOT, 'analysis', `${hash(`${digest}:${signature}`)}.json`);
    try { results[i] = { ...await readJSON(cache), unitId: image.id }; }
    catch { pending.push({ i, image, file, cache }); }
  }
  // Revalidate TOPIQ even on a fully cached replay: unavailable models must expose quality=null.
  if (results.some(Boolean)) {
    const preflight = (await score([path.resolve(directory, images[0].path)]))[0];
    if (preflight.model === 'unavailable') for (const result of results.filter(Boolean)) {
      result.metrics = { ...result.metrics, quality: null, aesthetic: null };
      result.scorer = preflight;
      result.warnings = [...result.warnings, preflight.warning];
    }
  }
  // Keep model workers alive over the batch, as the pipeline does; no concurrent batches.
  console.error(`bench: ${pending.length}/${images.length} uncached images, serial metrics/scorer`);
  const analyzed = [];
  for (const [j, item] of pending.entries()) {
    analyzed.push(await analyzeImage({ filePath: item.file, analysisPath: item.file }));
    if (j % 20 === 0) console.error(`metrics ${j + 1}/${pending.length}`);
  }
  const scored = await score(pending.map(p => p.file));
  console.error('bench: faces');
  const detectedFaces = await detectFaces(pending.map(p => p.file));
  console.error('bench: pose (one CPU worker)');
  const poses = await detectPose(pending.map((p, j) => ({ id: p.image.id, filePath: p.file,
    faces: detectedFaces[j]?.faceDetails ?? [] })), { size: 1 });
  for (const [j, item] of pending.entries()) {
    const face = detectedFaces[j], scorer = scored[j], pose = poses[j], faces = face?.faceDetails ?? [];
    const metrics = normalizeMetrics({ ...analyzed[j].metrics, quality: scorer.quality, aesthetic: scorer.aesthetic,
      faces: face?.faces, eyesClosed: face?.eyesClosed });
    const flags = [...new Set([...(analyzed[j].qualityFlags ?? []), ...(face?.eyesClosed > 0 ? ['eyes-closed'] : [])])];
    const signals = pose?.available ? computeSignals(pose) : undefined;
    const result = { metrics, flags, faces, scorer, signals, verdicts: evaluateRules(signals, { faces }),
      warnings: [scorer.warning, face?.warning, pose?.error?.message].filter(Boolean) };
    await writeFile(item.cache, JSON.stringify(result));
    results[item.i] = { ...result, unitId: item.image.id };
  }
  for (const result of results) warnings.push(...result.warnings);
  return results;
}
async function replayCandidates(manifest,baseline,warnings) {
 const {measureCandidates,evaluateCandidateRules}=await import('../src/core/candidate-measurements.js');
 const results=[],lookup=new Map();
 for(const image of manifest.images){
  const directory=path.join(ROOT,'syn'),file=path.resolve(directory,image.path);
  if(!file.startsWith(`${directory}${path.sep}`)||file.includes('未删减'))throw new Error('Unsafe benchmark path');
  const digest=hash(await readFile(file));
  if(digest!==image.sha256)throw new Error(`Image checksum mismatch: ${image.id}`);
  const pair=manifest.pairs.find(p=>p.degradedId===image.id);
  let result;
  if(pair?.experimental){
   const source=lookup.get(pair.sourceId);
   if(!source)throw new Error('W5 source must precede transformed images');
   // Pixel measurements only: expensive model evidence is held constant as an oracle.
   result=structuredClone(source);
   const pixel=await analyzeImage({filePath:file,analysisPath:file});
   result.metrics=normalizeMetrics({...pixel.metrics,quality:source.metrics.quality,
    aesthetic:source.metrics.aesthetic,faces:source.metrics.faces,eyesClosed:source.metrics.eyesClosed});
   result.flags=[...new Set([...(pixel.qualityFlags??[]),...source.flags.filter(f=>f==='eyes-closed')])];
  }else{
   const cache=path.join(ROOT,'analysis',`${hash(`${digest}:${baseline.analysisSignature}`)}.json`);
   try{result=await readJSON(cache);}catch{throw new Error(`Missing baseline cache ${image.id}; refusing cold model run`);}
  }
  result.unitId=image.id;
  result.candidateMeasurements=await measureCandidates(file,{metrics:result.metrics,faces:result.faces,signals:result.signals});
  result.candidateVerdicts=evaluateCandidateRules(result.candidateMeasurements,result.signals);
  results.push(result);lookup.set(image.id,result);warnings.push(...(result.warnings??[]));
 }
 await mkdir('/tmp/w5-validate-qa',{recursive:true});
 await writeFile('/tmp/w5-validate-qa/bench-results.json',JSON.stringify(results));
 return results;
}

async function focusScore(file, face) {
  const input = await readFile(file);
  const focus = await analyzeFocus({ nativeBuffer: input, faces: face ? [face] : [] });
  return focus.eyeSharpnessNative;
}

async function runFocusBenchmark(compare) {
  const manifest = await readJSON(SYN);
  const outRoot = '/tmp/w6-focus-qa/tsyn';
  await mkdir(outRoot, { recursive: true });
  const sourceById = new Map(manifest.sources.map(source => [source.id, source]));
  const rows = [];
  for (const pair of manifest.pairs) {
    const source = sourceById.get(pair.sourceId);
    const face = source?.faces?.[0];
    const sourceFile = path.join(ROOT, 'syn', source.path);
    const degradedFile = path.join(ROOT, 'syn', pair.path);
    const oldSource = normalizeMetrics((await analyzeImage({ filePath: sourceFile, analysisPath: sourceFile })).metrics).sharpness;
    const oldDegraded = normalizeMetrics((await analyzeImage({ filePath: degradedFile, analysisPath: degradedFile })).metrics).sharpness;
    const newSource = await focusScore(sourceFile, face);
    const newDegraded = await focusScore(degradedFile, face);
    rows.push({ id: pair.id, degradation: pair.degradation, sourceId: pair.sourceId,
      oldCorrect: oldSource > oldDegraded,
      focusCorrect: Number.isFinite(newSource) && Number.isFinite(newDegraded) && newSource > newDegraded,
      oldSource, oldDegraded, newSource, newDegraded });
  }
  const eyeRows = [];
  for (const source of manifest.sources.filter(s => s.faces?.length)) {
    const input = await sharp(path.join(ROOT, 'syn', source.path));
    const meta = await input.metadata(); const face = source.faces[0].box;
    const left = Math.max(0, Math.floor(face[0] * meta.width));
    const top = Math.max(0, Math.floor(face[1] * meta.height));
    const width = Math.max(1, Math.ceil((face[2] - face[0]) * meta.width));
    const height = Math.max(1, Math.ceil((face[3] - face[1]) * meta.height * .5));
    const crop = await input.extract({ left, top, width: Math.min(width, meta.width - left),
      height: Math.min(height, meta.height - top) }).blur(8).toBuffer();
    const degraded = await sharp(path.join(ROOT, 'syn', source.path))
      .composite([{ input: crop, left, top }]).jpeg({ quality: 95 }).toBuffer();
    const file = path.join(outRoot, `${source.id}-eye-local.jpg`);
    await writeFile(file, degraded);
    const sourceFile = path.join(ROOT, 'syn', source.path);
    const oldSource = normalizeMetrics((await analyzeImage({ filePath: sourceFile,
      analysisPath: sourceFile })).metrics).sharpness;
    const oldDegraded = normalizeMetrics((await analyzeImage({ filePath: file, analysisPath: file })).metrics).sharpness;
    const newSource = await focusScore(sourceFile, source.faces[0]);
    const newDegraded = await focusScore(file, source.faces[0]);
    eyeRows.push({ id: `${source.id}-eye-local`, degradation: 'eye-local-defocus', sourceId: source.id,
      oldCorrect: oldSource > oldDegraded,
      focusCorrect: Number.isFinite(newSource) && Number.isFinite(newDegraded) && newSource > newDegraded,
      oldSource, oldDegraded, newSource, newDegraded, path: file });
  }
  rows.push(...eyeRows);
  const summarize = list => ({ pairs: list.length, oldCorrect: list.filter(r => r.oldCorrect).length,
    oldAccuracy: list.length ? list.filter(r => r.oldCorrect).length / list.length : null,
    focusCorrect: list.filter(r => r.focusCorrect).length,
    focusAccuracy: list.length ? list.filter(r => r.focusCorrect).length / list.length : null,
    na: list.filter(r => !Number.isFinite(r.newSource) || !Number.isFinite(r.newDegraded)).length });
  const byDegradation = Object.fromEntries([...new Set(rows.map(r => r.degradation))]
    .map(type => [type, summarize(rows.filter(r => r.degradation === type))]));
  const report = { contractVersion: 1, createdAt: new Date().toISOString(), sourceManifest: SYN,
    protocol: 'old proxy sharpness vs native focus signal; eye-local blur changes only the face upper half; no model calls',
    all: summarize(rows), byDegradation, eyeLocal: summarize(eyeRows), rows };
  if (compare) report.compare = compare;
  await writeFile('/tmp/w6-focus-qa/tsyn-focus.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('nice -n 10 node scripts/bench.mjs [--generate] [--w5] [--compare <report.json>]'); return;
  }
  let generate = false, compare, w5 = false, focus = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--w5') w5 = true;
    else if (argv[i] === '--focus') focus = true;
    else if (argv[i] === '--generate') generate = true;
    else if (argv[i] === '--compare' && argv[i + 1]) compare = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  sharp.concurrency(1);
  process.env.EAGLE_SCORER_THREADS = '2';
  for (const key of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS']) process.env[key] = '2';
  if (!process.env.EAGLE_PYTHON) {
    const local = path.resolve('python_worker/.venv/bin/python');
    try { await access(local); process.env.EAGLE_PYTHON = local; }
    catch { throw new Error('Set EAGLE_PYTHON or install python_worker/.venv'); }
  }
  if (focus) return runFocusBenchmark(compare);
  if (generate) {
    const child = spawnSync(process.execPath, ['ml/bench/generate-syn.mjs', ...(w5 ? ['--w5'] : [])], {
      stdio: 'inherit', env: process.env });
    if (child.status !== 0) throw new Error('Synthetic generation failed');
  }
  const manifestPath=w5?path.join(ROOT,'w5-manifest.json'):SYN;
  const manifest = await readJSON(manifestPath);
  let triage;
  try { triage = await readJSON(path.join(ROOT, 'phototriage', 'manifest.json')); }
  catch {
    try { triage = await readJSON(path.join(ROOT, 'phototriage', 'provenance.json')); }
    catch { triage = await readJSON('test/fixtures/bench-triage-manifest.json'); }
  }
  await mkdir(path.join(ROOT, 'analysis'), { recursive: true });
  const warnings = [], signature = await analysisSignature();
  const baseline = w5 ? await readJSON(compare || 'data/cache/bench/reports/2026-10-10T05-56-30-237Z/report.json') : null;
  if(w5 && manifest.parentManifestSha256!==baseline.manifestSha256)
    throw new Error('W5 parent manifest differs from baseline; source identity unverified');
  const results = w5 ? await replayCandidates(manifest,baseline,warnings) :
    await analyze(manifest.images, path.join(ROOT, 'syn'), warnings, signature);
  if(w5 && triage.status==='ready')throw new Error('W5 replay refuses cold triage models; cached triage replay not implemented');
  const triageResults = triage.status === 'ready' ?
    await analyze(triage.groups.flatMap(g => g.images), path.join(ROOT, 'phototriage'), warnings, signature) : [];
  const git = args => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
  const report = { contractVersion: 1, createdAt: new Date().toISOString(), branch: git(['branch', '--show-current']),
    commit: git(['rev-parse', 'HEAD']), analysisSignature: signature, manifestSha256: hash(await readFile(manifestPath)),
    ...(w5?{candidateSensitivity:evaluateCandidateSensitivity(manifest,results),
      modelReuse:'SHA256-verified baseline models; source geometry/quality for injected cases (oracle sensitivity only)',
      baselineSynthetic:evaluateSynthetic({...manifest,pairs:manifest.pairs.filter(p=>!p.experimental)},results)}:{}),
    synthetic: evaluateSynthetic(manifest, results), triage: evaluateTriage(triage, triageResults),
    warnings: [...new Set(warnings)], methodology: 'existing scoring functions; fixed benchmark groups; no Eagle I/O' };
  if (compare) {
    const previous = await readJSON(compare);
    if (!w5 && previous.manifestSha256 !== report.manifestSha256) throw new Error('Comparison requires identical synthetic manifest');
    report.comparison = {...compareSynthetic(previous.synthetic,report.synthetic,{allowExtended:w5}),
      triageTop1Delta: report.triage.top1 && previous.triage.top1 ? report.triage.top1.rate - previous.triage.top1.rate : null};
  }
  const out = path.join(ROOT, 'reports', report.createdAt.replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'report.md'), markdown(report));
  console.log(out);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
