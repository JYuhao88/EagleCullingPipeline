#!/usr/bin/env node
import { requireLocalSetting } from '../src/core/local-config.js';
/* Cache-only evaluation for W6 candidate selection. No Eagle writes or model calls. */
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { rankGroup } from "../src/core/ranking.js";
import { buildCandidateSet } from "../src/core/candidates.js";
import { groupResults } from "../src/core/grouping.js";

const ROOT = process.cwd();
const QA = "/tmp/w6-pareto-qa";
const MANIFEST = path.join(ROOT, "test/fixtures/bench-syn-manifest.json");
const BENCH_CACHE = path.join(ROOT, "data/cache/bench");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function bootstrap(rows, metric, seed = 42, samples = 1000) {
  if (!rows.length) return { low: null, high: null, samples: 0 };
  let state = seed >>> 0; const random = () => {
    state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000;
  };
  const values = [];
  for (let sample = 0; sample < samples; sample++) {
    const picked = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    values.push(metric(picked));
  }
  return { low: quantile(values, 0.025), high: quantile(values, 0.975), samples };
}
function strictSet(items) {
  const epsilon = buildCandidateSet(items).epsilon;
  return buildCandidateSet(items, { epsilon: Object.fromEntries(Object.keys(epsilon).map(key => [key, 0])) });
}
function oldTop(items) {
  const ranking = rankGroup(items);
  return { ranking, top: ranking[0]?.unitId || null };
}
function representative(set, ranking) {
  const order = new Map(ranking.map(entry => [entry.unitId, entry.rank]));
  return [...(set.unitIds || [])].sort((a, b) =>
    (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))[0] || null;
}
function pairValue(set, pair) {
  const sourceIn = set.unitIds.includes(pair.sourceId);
  const degradedIn = set.unitIds.includes(pair.degradedId);
  return sourceIn && !degradedIn ? 1 : sourceIn && degradedIn ? 0.5 : 0;
}
function strategySummary(groups) {
  const output = {};
  for (const strategy of ["old", "strict", "epsilon"]) {
    const rows = groups.map(group => group[strategy]);
    const pairs = rows.flatMap(row => row.pairs);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
    const recall = rows.filter(row => row.frontier.includes(row.sourceId)).length / (rows.length || 1);
    const severe = rows.flatMap(row => row.severeRows.map(item => ({ item, row })));
    const severeExcluded = severe.length
      ? severe.filter(value => !value.row.frontier.includes(value.item.unitId)).length / severe.length : null;
    output[strategy] = {
      groups: rows.length,
      top1: mean(rows.map(row => row.representative === row.sourceId ? 1 : 0)),
      pairwise: mean(pairs.map(row => row.value)),
      frontierRecall: recall,
      frontierMeanSize: mean(rows.map(row => row.frontier.length)),
      sourceExcludedRate: 1 - recall,
      severeExcludedRate: severeExcluded,
      rejectedAllGroups: rows.filter(row => row.rejectedAll).length,
      bootstrap: {
        top1: bootstrap(rows, sample => mean(sample.map(row => row.representative === row.sourceId ? 1 : 0))),
        pairwise: bootstrap(pairs, sample => mean(sample.map(row => row.value))),
        frontierRecall: bootstrap(rows, sample => mean(sample.map(row => row.frontier.includes(row.sourceId) ? 1 : 0))),
        frontierMeanSize: bootstrap(rows, sample => mean(sample.map(row => row.frontier.length))),
        sourceExcludedRate: bootstrap(rows, sample => 1 - mean(sample.map(row => row.frontier.includes(row.sourceId) ? 1 : 0)))
      }
    };
  }
  return output;
}
function buildStrategyGroup(sourceId, items, pairs) {
  const oldRanking = oldTop(items), old = { ...oldRanking, unitIds: oldRanking.top ? [oldRanking.top] : [] };
  const strict = strictSet(items), epsilon = buildCandidateSet(items);
  const severeRows = items.filter(item => (item.flags || []).some(flag =>
    ["blurry", "eyes-closed", "overexposed", "underexposed", "noisy"].includes(flag)))
    .map(item => ({ unitId: item.unitId }));
  const make = (set, ranking) => ({
    sourceId, representative: representative(set, ranking), frontier: set.unitIds || [],
    rejectedAll: Boolean(set.rejectedAll), severeRows,
    pairs: pairs.map(pair => ({ value: pairValue(
      set === old ? { unitIds: [oldTop(pair.items).top] } :
        (pair === undefined ? set : (set.mode === "epsilon-pareto"
          ? buildCandidateSet(pair.items, { epsilon: set.epsilon }) : strictSet(pair.items))), pair),
      degradation: pair.degradation }))
  });
  return { sourceId, old: make(old, old.ranking), strict: make(strict, old.ranking),
    epsilon: make(epsilon, old.ranking), entries: epsilon.entries, degradations: pairs };
}
async function loadBench() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const names = (await readdir(path.join(BENCH_CACHE, "reports"))).sort();
  const report = JSON.parse(await readFile(path.join(BENCH_CACHE, "reports", names.at(-1), "report.json")));
  const cache = new Map();
  for (const image of manifest.images) {
    const file = path.join(BENCH_CACHE, "analysis", `${hash(`${image.sha256}:${report.analysisSignature}`)}.json`);
    cache.set(image.id, { ...(JSON.parse(await readFile(file))), unitId: image.id });
  }
  const groups = manifest.sources.map(source => {
    const variants = manifest.pairs.filter(pair => pair.sourceId === source.id);
    const items = [cache.get(source.id), ...variants.map(pair => cache.get(pair.degradedId))].filter(Boolean);
    const pairs = variants.map(pair => ({
      sourceId: source.id, degradedId: pair.degradedId, degradation: pair.degradation,
      expectedGate: Boolean(pair.expectedGate),
      items: [cache.get(source.id), cache.get(pair.degradedId)]
    }));
    const group = buildStrategyGroup(source.id, items, pairs);
    return { ...group, degradations: variants };
  });
  return { manifest, report, groups };
}
async function evaluateTsynt() {
  const { manifest, report, groups } = await loadBench();
  const byDegradation = {};
  for (const degradation of new Set(manifest.pairs.map(pair => pair.degradation))) {
    byDegradation[degradation] = {};
    for (const strategy of ["old", "strict", "epsilon"]) {
      const selected = groups.filter(group => group.degradations.some(pair => pair.degradation === degradation));
      const rows = selected.map(group => group[strategy]);
      const pairs = rows.flatMap(row => row.pairs.filter(pair => pair.degradation === degradation));
      const mean = values => values.reduce((sum, value) => sum + (value.value ?? value), 0) / (values.length || 1);
      const recall = mean(rows.map(row => row.frontier.includes(row.sourceId) ? 1 : 0));
      byDegradation[degradation][strategy] = { groups: rows.length, pairs: pairs.length,
        top1: mean(rows.map(row => row.representative === row.sourceId ? 1 : 0)),
        pairwise: mean(pairs), frontierRecall: recall,
        frontierMeanSize: mean(rows.map(row => row.frontier.length)), sourceExcludedRate: 1 - recall,
        bootstrap: {
          top1: bootstrap(rows, sample => mean(sample.map(row => row.representative === row.sourceId ? 1 : 0))),
          pairwise: bootstrap(pairs, sample => mean(sample)),
          frontierRecall: bootstrap(rows, sample => mean(sample.map(row => row.frontier.includes(row.sourceId) ? 1 : 0)))
        } };
    }
  }
  return { benchmark: "T-syn", cacheSignature: report.analysisSignature, sourceGroups: groups.length,
    metrics: strategySummary(groups), byDegradation,
    methodology: "Source is the labelled winner. Frontier top1 uses the highest old-ranking " +
      "frontier member as a deterministic representative. Pairwise frontier ties score 0.5. " +
      "Bootstrap resamples source groups, seed 42, 1000 draws.",
    caveat: "Controlled source-over-degradation labels do not measure aesthetic preference." };
}
function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
async function loadShantou() {
  const oldData = JSON.parse(await readFile(requireLocalSetting("ECP_EVAL_RUN"), "utf8"));
  const lines = (await readFile(requireLocalSetting("ECP_EVAL_CACHE"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line).result);
  const cache = new Map(lines.map(result => [result.fingerprint, result]));
  const results = oldData.results.map(result => cache.get(result.fingerprint) || result);
  const groups = groupResults(results);
  const oldPreferred = new Map(oldData.groups.flatMap(group => Object.entries(group.suggested || {})
    .filter(([, action]) => action === "selected").map(([id]) => [id, id])));
  return { groups: groups.map(group => {
    const old = oldTop(group.items), preferred = group.unitIds.map(id => oldPreferred.get(id)).find(Boolean) || old.top;
    const candidateSet = buildCandidateSet(group.items);
    return { ...group, oldPreferred: preferred, oldTop: old.top, ranking: old.ranking,
      candidateSet, entries: new Map(candidateSet.entries.map(entry => [entry.unitId, entry])),
      oldExcluded: !candidateSet.unitIds.includes(preferred) };
  }) };
}
async function makeContactSheet(row, index) {
  const dir = path.join(QA, "images"); await mkdir(dir, { recursive: true });
  const width = 260, height = 215, columns = Math.min(4, Math.max(1, row.items.length));
  const composites = [];
  for (const [position, item] of row.items.entries()) {
    if (!item.previewPath) continue;
    try { await access(item.previewPath); } catch { continue; }
    const entry = row.entries.get(item.unitId);
    const first = `${position + 1} ${item.name || item.unitId}`;
    const second = `${entry?.candidate ? "前沿" : "非前沿"} ${entry?.leaders?.join("、") || ""}`;
    const svg = `<svg width="${width}" height="${height}">` +
      `<rect y="180" width="${width}" height="35" fill="white" fill-opacity=".85"/>` +
      `<text x="5" y="195" font-size="11">${escape(first)}</text>` +
      `<text x="5" y="209" font-size="10">${escape(second)}</text></svg>`;
    const tile = await sharp(item.previewPath).resize(width, height, { fit: "cover" })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
    composites.push({ input: tile, left: (position % columns) * width, top: Math.floor(position / columns) * height });
  }
  const rows = Math.ceil(composites.length / columns), file = path.join(dir, `group-${String(index + 1).padStart(3, "0")}.jpg`);
  await sharp({ create: { width: columns * width, height: rows * height, channels: 3, background: "#eeeeee" } })
    .composite(composites).jpeg({ quality: 88 }).toFile(file);
  return path.relative(QA, file);
}
async function evaluateShantou() {
  const { groups } = await loadShantou();
  const selected = groups.filter(group => group.candidateSet.unitIds.length >= 2 ||
    group.oldExcluded || group.candidateSet.rejectedAll);
  const images = [];
  for (const [index, row] of selected.entries()) {
    images.push({ row, image: await makeContactSheet(row, index) });
  }
  const html = ["<!doctype html><meta charset=utf-8><title>W6 Pareto 汕头联系表</title>",
    "<style>body{font-family:system-ui}article{margin:20px 0;border-top:1px solid #aaa}img{max-width:1040px}li{margin:3px}</style>",
    `<h1>汕头候选集目测联系表</h1><p>当前代码缓存回放；无摄影师精选真值。` +
    `组数 ${groups.length}，前沿≥2/旧首选不在前沿/整组拒绝：` +
    `${groups.filter(g => g.candidateSet.unitIds.length >= 2).length}/` +
    `${groups.filter(g => g.oldExcluded).length}/` +
    `${groups.filter(g => g.candidateSet.rejectedAll).length}。</p>`];
  for (const { row, image } of images) {
    html.push(`<article><h2>${escape(row.id)} · ${row.items.length} 张 · ` +
      `前沿 ${row.candidateSet.unitIds.length} 张${row.oldExcluded ? " · 旧首选不在前沿" : ""}` +
      `${row.candidateSet.rejectedAll ? " · 整组拒绝" : ""}</h2>`,
      `<img src="${escape(image)}"><ul>`);
    for (const item of row.items) { const entry = row.entries.get(item.unitId);
      html.push(`<li>${escape(item.name || item.unitId)}：` +
        `${entry?.candidate ? "前沿" : "非前沿"}；` +
        `${escape(entry?.leaders?.join("、") || "无领先维度")}</li>`); }
    html.push("</ul></article>");
  }
  await writeFile(path.join(QA, "shantou-contact.html"), html.join("\n"));
  const distribution = Object.fromEntries([...new Set(groups.map(group => group.candidateSet.unitIds.length))].sort((a, b) => a - b)
    .map(size => [size, groups.filter(group => group.candidateSet.unitIds.length === size).length]));
  return { groups: groups.length, frontierSizeDistribution: distribution,
    frontierAtLeastTwo: groups.filter(group => group.candidateSet.unitIds.length >= 2).length,
    oldPreferredExcluded: groups.filter(group => group.oldExcluded).length,
    rejectedAll: groups.filter(group => group.candidateSet.rejectedAll).length,
    contactSheet: path.join(QA, "shantou-contact.html") };
}
await mkdir(QA, { recursive: true });
const tsyn = await evaluateTsynt();
const shantou = await evaluateShantou();
const report = { contractVersion: 1, generatedAt: new Date().toISOString(), tsyn, shantou,
  recommendation: "默认继续旧排序；候选集用于低把握/前沿≥2组的人工复核，待真实偏好标签和稳定前沿规模验证后再考虑默认切换。" };
await writeFile(path.join(QA, "candidate-evaluation.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(QA, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
