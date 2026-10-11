import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 导出 JSON：{ runId, labels: [{ groupId, bestUnitId }] }；bestUnitId 为 null 表示“都不行/无法判断”。

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

export function renderSpotCheck(data, runId, previewPaths = new Map()) {
  const results = new Map((data.results || []).map((item) => [item.unitId, item]));
  const items = new Map((data.items || []).map((item) => [item.id, item]));
  const units = new Map((data.units || []).map((unit) => [unit.id, unit]));
  const groups = (data.groups || []).filter((group) => group.unitIds.length >= 2);
  const rows = groups.map((group) => {
    const orderedUnitIds = [...group.unitIds].sort((a, b) =>
      (group.ranking?.find((entry) => entry.unitId === a)?.rank ?? Infinity)
      - (group.ranking?.find((entry) => entry.unitId === b)?.rank ?? Infinity));
    const cards = orderedUnitIds.map((unitId) => {
      const item = results.get(unitId) || {};
      const unit = units.get(unitId);
      const filename = item.name || items.get(unit?.primaryItemId)?.name || unitId;
      const rank = group.ranking?.find((entry) => entry.unitId === unitId);
      const preview = previewPaths.get(unitId) || (item.previewPath
        ? pathToFileURL(path.resolve(item.previewPath)).href
        : `http://127.0.0.1:43125/runs/${encodeURIComponent(runId)}/preview/${encodeURIComponent(unitId)}`);
      const metrics = item.metrics || {};
      const parts = [`清晰度 ${formatMetric(metrics.sharpness)}`,
        `曝光 ${formatMetric(metrics.exposure)}`,
        `质量 ${formatMetric(metrics.quality ?? item.scorer?.quality)}`].join(" · ");
      const reasons = (rank?.reasons || []).join("；") || "无特别说明";
      return `<article class="card" data-group="${escape(group.id)}" data-unit="${escape(unitId)}" tabindex="0">
        <img src="${escape(preview)}" alt="${escape(filename)}">
        <div>${escape(filename)}</div>
        <div class="model">排名：${rank?.rank ?? "-"} · 总分：${formatMetric(rank?.score)}</div>
        <div class="model">${escape(parts)}</div><div class="model reason">${escape(reasons)}</div>
      </article>`;
    }).join("\n");
    return `<section class="group" data-group="${escape(group.id)}"><h2>${escape(group.id)}</h2><div class="cards">${cards}</div>
      <button class="unable" type="button">都不行 / 无法判断</button></section>`;
  }).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>人工抽查 ${escape(runId)}</title>
<style>
body{font:15px system-ui;margin:20px}.group{margin:18px 0;padding:12px;border:1px solid #ddd}
.cards{display:flex;gap:10px;overflow:auto}.card{width:220px;padding:8px;border:3px solid transparent;cursor:pointer}
.card.selected{border-color:#16803c}.card img{width:180px;height:140px;object-fit:contain;background:#eee}
.model{display:none;color:#666}.show-model .model{display:block}.reason{font-size:13px}button{margin-top:8px}.unable.active{background:#faa}
</style>
<h1>人工抽查：${escape(runId)}</h1><label><input id="show-model" type="checkbox"> 显示模型排名</label><main>${rows || "<p>没有包含至少两个单元的组。</p>"}</main>
<button id="export" type="button">导出标注</button>
<script>
const runId=${JSON.stringify(runId)};
const key='spot-check:'+runId;
const labels=JSON.parse(localStorage.getItem(key)||'{}');
const save=()=>localStorage.setItem(key,JSON.stringify(labels));
document.querySelector('#show-model').addEventListener('change',e=>
  document.body.classList.toggle('show-model',e.target.checked));
document.querySelectorAll('.group').forEach(group=>{
  const id=group.dataset.group; const current=labels[id];
  if(current===null) group.querySelector('.unable').classList.add('active');
  group.querySelectorAll('.card').forEach(card=>{
    if(card.dataset.unit===current) card.classList.add('selected');
    card.addEventListener('click',()=>{
      labels[id]=card.dataset.unit;
      group.querySelectorAll('.card').forEach(x=>x.classList.remove('selected'));
      card.classList.add('selected'); group.querySelector('.unable').classList.remove('active'); save();
    });
  });
  group.querySelector('.unable').addEventListener('click',()=>{
    labels[id]=null; group.querySelectorAll('.card').forEach(x=>x.classList.remove('selected'));
    group.querySelector('.unable').classList.add('active'); save();
  });
});
document.querySelector('#export').addEventListener('click',()=>{
  const output={runId,labels:[...document.querySelectorAll('.group')].map(g=>({
    groupId:g.dataset.group,bestUnitId:Object.hasOwn(labels,g.dataset.group)
      ? labels[g.dataset.group]:null}))};
  const blob=new Blob([JSON.stringify(output,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='spot-check-labels.json'; a.click();
});
</script>`;
}

async function main() {
  const runIndex = process.argv.indexOf("--run");
  const runId = runIndex >= 0 ? process.argv[runIndex + 1] : process.argv[2];
  if (!runId || runId.startsWith("--")) throw new Error("用法：<runId> 或 --run <runId> [--out <file>]");
  const outIndex = process.argv.indexOf("--out");
  const output = path.resolve(
    outIndex >= 0
      ? process.argv[outIndex + 1]
      : path.join("exports", "spot-check", `${runId}.html`),
  );
  const data = JSON.parse(await readFile(path.join("data", "runs", runId, "results.json"), "utf8"));
  await mkdir(path.join(path.dirname(output), "previews"), { recursive: true });
  const previewPaths = new Map();
  for (const result of data.results || []) {
    if (!result.previewPath) continue;
    const target = path.join(path.dirname(output), "previews", `${encodeURIComponent(result.unitId)}.jpg`);
    await cp(result.previewPath, target);
    previewPaths.set(result.unitId, `previews/${path.basename(target)}`);
  }
  await writeFile(output, renderSpotCheck(data, runId, previewPaths));
  console.log(`已生成 ${output}`);
}

function formatMetric(value) {
  return Number.isFinite(value) ? Number(value).toFixed(3) : "—";
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
