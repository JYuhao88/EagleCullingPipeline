// Eagle-native culling trial: writes clusters as tags, located issues as Eagle rect comments, and two smart folders.
// Every write is recorded in a ledger so `clear` restores the library exactly.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { readManifest, readRows } from '../src/core/segmented-results.js';
import { EagleApi } from '../src/core/eagle-api.js';
import { locatedIssues } from '../src/core/photo-facts.js';
import { momentClusters } from '../src/core/moments.js';

export const PREFIX = 'AI·';
export const TAG_REP = 'AI·代表';
export const TAG_DUP = 'AI·同簇';
export function clusterGroup(results, options) {
  const members = results.filter(result => Array.isArray(result?.embedding));
  const clusters = momentClusters(members.map(result => result.embedding), options);
  if (!clusters) return null;
  return clusters.map(indexes => indexes.map(i => members[i]).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)))
    .sort((a, b) => (b[0].score ?? 0) - (a[0].score ?? 0));
}

export function toComment(issue, item) {
  const [x0, y0, x1, y1] = issue.box;
  return { annotation: `${PREFIX}${issue.text}`, x: Math.round(x0 * item.width), y: Math.round(y0 * item.height),
    width: Math.max(1, Math.round((x1 - x0) * item.width)), height: Math.max(1, Math.round((y1 - y0) * item.height)) };
}

async function loadRun(runDirectory) {
  const manifest = await readManifest(runDirectory);
  const data = { results: [], units: [], items: [], groups: [] };
  for (const kind of Object.keys(data)) for await (const row of readRows(runDirectory, manifest, kind)) data[kind].push(row);
  return data;
}

export function buildPlan(data) {
  const results = new Map(data.results.map(row => [row.unitId, row]));
  const units = new Map(data.units.map(row => [row.id, row]));
  const items = new Map(data.items.map(row => [row.id, row]));
  const tags = new Map(), comments = new Map(), clusters = [];
  const addTag = (unitId, tag) => { for (const id of units.get(unitId)?.itemIds || []) tags.set(id, tag); };
  for (const group of data.groups) {
    const groupClusters = clusterGroup(group.unitIds.map(id => results.get(id)).filter(Boolean));
    if (!groupClusters) continue;
    clusters.push({ units: group.unitIds.length, sizes: groupClusters.map(c => c.length) });
    for (const cluster of groupClusters) cluster.forEach((result, index) => addTag(result.unitId, index ? TAG_DUP : TAG_REP));
  }
  for (const result of data.results) {
    const issues = locatedIssues(result);
    if (!issues.length) continue;
    for (const id of units.get(result.unitId)?.itemIds || []) {
      const item = items.get(id);
      if (item?.width && item?.height) comments.set(id, issues.map(issue => toComment(issue, item)));
    }
  }
  const folders = [...new Set(data.items.flatMap(item => item.folders || []))];
  return { tags, comments, clusters, folders };
}

function smartFolders(folders) {
  return [
    { name: `${PREFIX}筛片：收起重复后`, conditions: [
      { match: 'AND', rules: [{ property: 'folders', method: 'union', value: folders }], boolean: 'TRUE' },
      { match: 'AND', rules: [{ property: 'tags', method: 'union', value: [TAG_DUP] }], boolean: 'FALSE' }] },
    { name: `${PREFIX}筛片：有问题标注`, conditions: [
      { match: 'AND', rules: [{ property: 'comments', method: 'contain', value: PREFIX }], boolean: 'TRUE' }] },
  ];
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function apply(api, plan, ledgerFile) {
  const ledger = { tags: {}, comments: {}, smartFolders: [] };
  const save = () => writeFile(ledgerFile, JSON.stringify(ledger, null, 2));
  for (const [id, tag] of plan.tags) {
    const item = (await api.get('item/get', { id }))?.data?.[0];
    if (!item || item.tags.includes(tag)) continue;
    await api.updateItem({ id, tags: [...item.tags, tag] });
    ledger.tags[id] = tag; await pause(20);
  }
  await save();
  for (const [id, list] of plan.comments) {
    ledger.comments[id] = [];
    for (const comment of list) {
      const created = await api.post('item/addComment', { id, ...comment });
      if (created?.id) ledger.comments[id].push(created.id);
      await pause(20);
    }
  }
  await save();
  for (const folder of smartFolders(plan.folders)) {
    const created = await api.post('smartFolder/create', folder);
    if (created?.id) ledger.smartFolders.push(created.id);
  }
  await save();
  return ledger;
}

async function clear(api, ledgerFile) {
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  for (const id of ledger.smartFolders) await api.post('smartFolder/remove', { id }).catch(error => console.warn(id, error.message));
  for (const [id, commentIds] of Object.entries(ledger.comments))
    for (const commentId of commentIds) {
      await api.post('item/removeComment', { id, commentId }).catch(error => console.warn(id, error.message));
    }
  for (const [id, tag] of Object.entries(ledger.tags)) {
    const item = (await api.get('item/get', { id }))?.data?.[0];
    if (item?.tags.includes(tag)) await api.updateItem({ id, tags: item.tags.filter(value => value !== tag) });
  }
  await rm(ledgerFile);
}

// Replaces only the comments, so tags and smart folders the user is browsing stay put.
async function refreshComments(api, plan, ledgerFile) {
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  for (const [id, commentIds] of Object.entries(ledger.comments)) {
    for (const commentId of commentIds) await api.post('item/removeComment', { id, commentId }).catch(() => {});
    delete ledger.comments[id];
  }
  for (const [id, list] of plan.comments) {
    ledger.comments[id] = [];
    for (const comment of list) {
      const created = await api.post('item/addComment', { id, ...comment });
      if (created?.id) ledger.comments[id].push(created.id);
      await pause(20);
    }
  }
  await writeFile(ledgerFile, JSON.stringify(ledger, null, 2));
  return ledger;
}

async function main() {
  const [command, runId] = process.argv.slice(2);
  if (!['plan', 'apply', 'comments', 'clear'].includes(command) || !runId) {
    throw new Error('用法：node scripts/eagle-native.mjs plan|apply|comments|clear <runId>');
  }
  const root = path.resolve(import.meta.dirname, '..');
  const ledgerDir = path.join(root, 'data/cache/eagle-native');
  const ledgerFile = path.join(ledgerDir, `${runId}.json`);
  const api = new EagleApi();
  if (command === 'clear') { await api.assertLibrary(); await clear(api, ledgerFile); console.log('已清除'); return; }
  const runDirectory = path.join(root, 'data/runs', runId);
  const plan = buildPlan(await loadRun(runDirectory));
  const counts = { 代表: 0, 同簇: 0 };
  for (const tag of plan.tags.values()) counts[tag === TAG_REP ? '代表' : '同簇']++;
  const byText = {};
  for (const c of [...plan.comments.values()].flat()) {
    const key = c.annotation.replace(/：.*/, '');
    byText[key] = (byText[key] || 0) + 1;
  }
  console.log(JSON.stringify({ clusters: plan.clusters, tagItems: counts, commentItems: plan.comments.size, comments: byText }, null, 1));
  if (command === 'plan') return;
  await mkdir(ledgerDir, { recursive: true });
  await api.assertLibrary();
  if (command === 'comments') {
    const ledger = await refreshComments(api, plan, ledgerFile);
    console.log(`已替换批注：${Object.values(ledger.comments).flat().length} 条`);
    return;
  }
  const ledger = await apply(api, plan, ledgerFile);
  const commentCount = Object.values(ledger.comments).flat().length;
  console.log(`已写入：标签 ${Object.keys(ledger.tags).length}，批注 ${commentCount}，智能文件夹 ${ledger.smartFolders.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
