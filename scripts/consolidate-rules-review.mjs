import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const candidateFiles = ['portrait-v0.2-candidates', 'book-candidates', 'course-candidates', 'paper-candidates',
  'landscape-street-v0.2-candidates',
     'xhs-candidates'];
const evidenceFiles = ['existing-evidence', 'book-evidence', 'course-evidence', 'paper-evidence', 'wulin-evidence'];
// Human-reviewed overlap proposals. Facets and genre applicability remain in members.
export const mergeGroups = [
  ['P-BOOK-GROUP-HEAD-LAYERS', ['P-COURSE-GROUP-HEAD-LAYERS'], '均复核合影头位高低与错位；保留逐人可读条件。'],
  ['P-BOOK-EXPRESSION-VARIETY', ['P-COURSE-POSE-SERIES'], '同组保留互补变化；表情与角位作为独立子项，非逐帧重复扣分。'],
  ['G-BOOK-STORY-FUNCTION', ['P-BOOK-EVENT-COVERAGE', 'G-COURSE-EDIT-JUSTIFICATION'], '均比较各帧独特贡献后去重；保留事件覆盖与相邻帧说明子项。'],
  ['P-BOOK-ENVIRONMENT-CONTEXT', ['P-YD-BG-BLACK', 'P-YD-BG-BLUR'], '均要求叙事环境可读；暗部与虚化分列子项，不推广到所有背景。'],
  ['P-YD-LIGHT-DIRECTION', ['L-WL-LIGHT-COHERENCE'], '均复核光向与局部受光可信关系；分别保留人像、风光适用范围。'],
  ['P-YD-TONAL-GRAY', ['L-WL-TONE-DEPTH'], '均复核明暗层级是否支持空间重点；跨题材保留柔和低反差例外。'],

];
const related = {
 'P-YD-POSE-RESTRAINED':['P-POSE-WEIGHT','P-FACE-EXPRESSION'], 'P-YD-POSE-THEME':['P-FACE-EXPRESSION'],
 'P-BOOK-EXPRESSION-VARIETY':['P-FACE-EXPRESSION','S-UNIQUE-COVERAGE'],
 'G-BOOK-STORY-FUNCTION':['S-UNIQUE-COVERAGE','S-SEQUENCE-PRESERVE','L-SEQUENCE-PRESERVE'],
 'P-YD-BODY-PROPORTION':['P-HAND-WIDEANGLE'], 'P-YD-GAZE-DIRECTION':['S-NARRATIVE-EVIDENCE'],
 'P-YD-MOTION-READABLE':['S-MOTION-INTENT'], 'P-YD-ACTION-MOMENT':['S-MOMENT-ACTION'],
 'P-YD-FACE-OCCLUDED':['S-OCCLUSION-INTENT'], 'P-YD-NONFACE-HIGHLIGHTS':['P-EXPOSURE-INTENT','L-EXPOSURE-DETAIL'],
 'P-YD-NONFACE-SHADOWS':['L-SHADOW-RECOVERY'], 'P-YD-TILT':['L-HORIZON-LEVEL',
    'S-TILT-INTENT'],
 'P-BOOK-GROUP-READINESS':['P-FACE-EYES','P-FACE-EXPRESSION'], 'P-YD-NOISE':['L-NOISE-DETAIL','S-NOISE-STYLE'],
};
const kinds = ['source','exception','counterpoint'];
const brief = text => Array.from(text || '').slice(0,40).join('');
const unique = list => [...new Set(list)];
function sourceOf(e, fallback) {
 if(e.bookSlug) return ['book', e.bookSlug];
 if(e.paperSlug) return ['paper', e.paperSlug];
 if(e.courseSlug) return ['course', e.courseSlug];
 if(e.noteId) return ['social', 'xiaohongshu-comments'];
 return ['video', e.source || fallback || 'unknown-video'];
}
function normalized(e, ruleId, file, fallback) {
 const [type,source] = sourceOf(e,fallback);
 const originalKind = e.kind || e.polarity || null;
 const kind = kinds.includes(originalKind) ? originalKind : 'source';
 return {ruleId,file,type,source,kind,originalKind,paraphrase:brief(e.paraphrase
    || e.text),
  locator:e.locator ?? (e.bvid ? {bvid:e.bvid,segment:e.segment,t:e.t} : {noteId:e.noteId}),

  citationHash:createHash('sha256').update(e.paraphrase || e.text || '').digest('hex'),
  tier:e.tier ?? null, supports:e.supports || [], supportCount:e.supportCount
    || 1};
}
function summarize(items, reports) {
 // Inline citations and evidence-file copies count once; rule IDs do not duplicate citations after merging.
 const map = new Map();
 for(const e of items) {
  const key=JSON.stringify([e.type,e.source,e.kind,e.locator,e.citationHash]);

  const prev=map.get(key);
  if(prev) {prev.supports = [...new Map([...prev.supports,...e.supports].map(s=>[JSON.stringify(s),
    s])).values()];prev.supportCount=Math.max(prev.supportCount,e.supportCount);
    } else map.set(key,structuredClone(e));
 }
 const evidence=[...map.values()]; const bySource={};const totals=Object.fromEntries(kinds.map(k=>[k,
    0]));
 for(const e of evidence){
  const key=`${e.type}:${e.source}`;
  const bucket=bySource[key] ||= {type:e.type,source:e.source,sourceCount:0,
    exceptionCount:0,counterpointCount:0,supportLocatorCount:0};
  bucket[`${e.kind}Count`]++;totals[e.kind]++;
  bucket.supportLocatorCount += new Set([JSON.stringify([e.source,e.locator]),
    ...e.supports.map(s=>JSON.stringify([s.paperSlug || e.source,s.locator]))]).size;

 }
 // Expand aggregate supports per source without giving repeated locators extra votes.
 const supportMap = new Map();
 for (const e of evidence) {
  const citations = [{ source:e.source, locator:e.locator }, ...e.supports.map(item => ({
   source:item.paperSlug || e.source, locator:item.locator,
  }))];
  for (const source of unique(citations.map(item => item.source))) {
   const key = `${e.type}:${source}`;
   const bucket = supportMap.get(key) || {
    type:e.type, source, sourceCount:0, exceptionCount:0, counterpointCount:0, locators:new Set(),
   };
   bucket[`${e.kind}Count`]++;
   for (const item of citations.filter(item => item.source === source)) {
    bucket.locators.add(JSON.stringify(item.locator));
   }
   supportMap.set(key, bucket);
  }
 }
 const supportCountsBySource = Object.fromEntries([...supportMap].map(([key,bucket]) => {
  const { locators, ...counts } = bucket;
  return [key, { ...counts, uniqueLocatorCount:locators.size }];
 }));
 const yidao=evidence.filter(e=>e.source==='yidao-critiques');
 const tierCount={high:0,low:0,unknown:0};
 const segments=new Map(yidao.map(e=>[JSON.stringify([e.locator.bvid,e.locator.segment]),
    e.tier]));
 for(const tier of segments.values())tierCount[['夯','顶尖','人上人'].includes(tier)?'high':['NPC','拉'].includes(tier)?'low':'unknown']++;
 const reported=reports.filter(r=>r.source==='yidao-critiques');
 return {totals,bySource,supportCountsBySource,sourceTypeCount:unique(evidence.map(e=>e.type)).length,

  sourceIdentityCount:unique(evidence.flatMap(e=>[
    `${e.type}:${e.source}`,...e.supports.map(s=>`${e.type}:${s.paperSlug || e.source}`)])).length,
  supportingTypeCount:unique(evidence.filter(e=>e.kind==='source').map(e=>e.type)).length,

  evidence,frequencyReports:reports,yidao:{observedEpisodes:unique(yidao.map(e=>e.locator.bvid)).length,
    observedSegments:segments.size,observedTierContrast:tierCount,
   reportedEpisodesLowerBound:Math.max(0,...reported.map(r=>r.frequency?.episodes
    || r.frequency?.videos || 0)),
   reportedSegmentsLowerBound:Math.max(0,...reported.map(r=>r.frequency?.segments
    || 0)),
   aggregation:'频次和档位原报告逐项保留；重叠未知，不相加。observed 仅已附证据。'}};
}
export async function buildReview(projectRoot=root) {
 const read = async name => JSON.parse(await readFile(path.join(projectRoot,
    `src/rules/${name}.json`),'utf8'));
 const inputs={}; const candidates=[];const formal=[]; const evidence=[]; const
    reports=[];
 for(const name of candidateFiles){const d=inputs[`candidates/${name}.json`]=await
    read(`candidates/${name}`);for(const r of d.rules)candidates.push({...r,
    library:r.library || d.library || (r.id.startsWith('P-')?'portrait':
    r.id.startsWith('L-')?'landscape':r.id.startsWith('S-')?'street':'general'),inputFile:`candidates/${name}.json`});}
 for(const name of ['portrait','general','landscape','street']){const d=inputs[`${name}.json`]=await read(name);
  for(const r of d.rules)formal.push({...r,library:name,
    inputFile:`${name}.json`});}
 const collect=(r,file,fallback)=>{
  for(const e of r.evidence || [])evidence.push(normalized(e,r.id,file,fallback));

  if(r.frequency || r.tierContrast)reports.push({ruleId:r.id,file,source:fallback,
    frequency:r.frequency || null,tierContrast:r.tierContrast || null});
 };
 for(const r of [...candidates,...formal])collect(r,r.inputFile,r.source);
 for(const name of evidenceFiles){const d=inputs[`candidates/${name}.json`]=await
    read(`candidates/${name}`);
  for(const r of d.rules || [])collect(r,`candidates/${name}.json`,r.source
    || d.source);
  for(const e of d.evidence || [])evidence.push(normalized(e,e.ruleId,`candidates/${name}.json`));
 }
 const aliasMap=Object.fromEntries(mergeGroups.flatMap(([id,aliases])=>aliases.map(a=>[a,
    id])));
 const byId=new Map(candidates.map(r=>[r.id,r]));
 for(const [id,aliases] of mergeGroups)if(![id,...aliases].every(id=>byId.has(id)))throw Error('Unknown merge member');
 const stats = ids => summarize(evidence.filter(e=>ids.includes(e.ruleId)),reports.filter(r=>ids.includes(r.ruleId)));

 const entries=candidates.filter(r=>!aliasMap[r.id]).map(r=>{
  const group=mergeGroups.find(g=>g[0]===r.id);const aliases=group?.[1] || [];
    const members=[r,...aliases.map(id=>byId.get(id))];const summary=stats(members.map(m=>m.id));

  const measurable=members.some(m=>m.check?.by==='measure');const hybrid=members.some(m=>m.check?.by==='measure+teacher');
  const impact=members.some(m=>m.severity==='gate')?'gate':members.some(m=>m.severity==='penalty')?'ranking':'hint';
  const frequency=Math.max(summary.yidao.reportedSegmentsLowerBound,summary.evidence.length,
    ...summary.frequencyReports.map(r=>r.frequency?.segments || r.frequency?.points
    || 0));
  const agreement=summary.supportingTypeCount/(summary.sourceTypeCount || 1)
    * summary.totals.source/(summary.totals.source+summary.totals.counterpoint
    || 1);
  const components={consistency:Math.round(30*Math.max(0,summary.supportingTypeCount-1)*agreement),
    frequency:Math.round(20*Math.log2(1+frequency)/Math.log2(201)),measurement:measurable?12:hybrid?6:0,
    impact:impact==='gate'?20:impact==='ranking'?10:0};
  return {id:r.id,title:r.title,isSuggestion:true,aliases,mergeReason:group?.[2]
    || null,
   members:members.map(m=>({id:m.id,library:m.library,title:m.title,statement:m.statement,
    check:m.check,severity:m.severity,exceptions:m.exceptions || [],inputFile:m.inputFile})),

   relatedFormalRules:related[r.id] || [],evidenceSummary:summary,
   recommendation:aliases.length?'merge':measurable?'needs-measure':'approve',

   recommendationReason:aliases.length?'先确认各子项与适用题材，再手动归并；不自动批准别名。':measurable?'验证代理信号的可观测性和例外后再批准；不新增阈值。':'建议以现有强度审核；有反例时修改或暂缓，不自动入库。',
   priority:{score:Object.values(components).reduce((a,b)=>a+b,0),components,
    measurable,hybrid,impact,frequencyBasis:frequency,agreementHeuristic:Number(agreement.toFixed(3))}};

 });
 entries.sort((a,b)=>b.priority.score-a.priority.score || a.id.localeCompare(b.id));
    entries.forEach((e,i)=>e.priority.rank=i+1);
 const formalRules=formal.map(r=>({id:r.id,title:r.title,library:r.library,severity:r.severity,
    check:r.check,evidenceSummary:stats([r.id])}));
 const exceptionGroups=formalRules.map(r=>{
  const items=r.evidenceSummary.evidence.filter(e=>e.kind==='exception');
  const representatives=[];for(const e of [...items].sort((a,b)=>a.type.localeCompare(b.type)))if(representatives.length<3
    && !representatives.some(p=>p.source===e.source))representatives.push(e);

  for(const e of items)if(representatives.length<Math.min(3,items.length)&&!representatives.includes(e))representatives.push(e);

  return {ruleId:r.id,title:r.title,severity:r.severity,count:items.length,items,
    representatives};
 }).filter(g=>g.count).sort((a,b)=>(b.severity==='gate')-(a.severity==='gate')
    || b.count-a.count || a.ruleId.localeCompare(b.ruleId));
 return {contractVersion:1,isSuggestion:true,notice:'全部为审核建议，非审核决定；不修改原候选、正式规则或 decisions.json。',
  methodology:{
   dedup:'同来源、kind、定位、转述去重；缺失kind及issue/praise映射为source，originalKind保留。',
   counts:'计数为聚合证据条数；supports单独计定位数，不当作独立观点。' +
    'sourceTypeCount按video/book/course/paper/social；教师独立列来源。' +
    'bySource计主出处聚合条数，supportCountsBySource展开支持出处，同一观点每来源计一次。',
   ranking:'score = consistency + frequency + measurement + impact；' +
    'consistency=30×(支持来源种类数−1)×(支持种类/全部种类)×source/(source+counterpoint)，逐项四舍五入；' +
    '一致性为来源类型广度×支持占比启发式，不是科学置信度。frequency用原报告与已附条数最大值，' +
    '20×log2(1+n)/log2(201)；measure=12，hybrid=6；gate=20，penalty=10，hint=0。例外不作反对票。',
   limits:'跨题材归并必须保留members的适用范围和子项；relatedFormalRules仅关联，证据不冒记为候选直接支持。未读取外部资料。'},
  inputFiles:Object.keys(inputs),inputHashes:Object.fromEntries(Object.entries(inputs).map(([file,
    data])=>[file,createHash('sha256').update(JSON.stringify(data)).digest('hex')])),
  counts:{candidates:candidates.length,consolidated:entries.length,
    mergeGroups:mergeGroups.length,aliases:Object.keys(aliasMap).length,formalRules:formalRules.length,
    exceptionGroups:exceptionGroups.length,exceptions:exceptionGroups.reduce((n,
    g)=>n+g.count,0)},aliasMap,entries,formalRules,exceptionGroups};
}
export function renderGuide(review){
 const action={approve:'建议批准',merge:'建议归并','needs-measure':'先验证测量',reject:'建议拒绝'};
 const rows=review.entries.slice(0,30).map(e=>{
  const s=e.evidenceSummary;
  const cells=[e.priority.rank, `${e.id} ${e.title}`, `${s.supportingTypeCount}/${s.sourceTypeCount}`,
   `${s.totals.source}/${s.totals.exception}/${s.totals.counterpoint}`,
   `${s.yidao.reportedEpisodesLowerBound}/${s.yidao.reportedSegmentsLowerBound}`,
   `${e.priority.measurable?'measure':'teacher'} / ${e.priority.impact}`,
   `${e.priority.score} / ${action[e.recommendation]}`];
  return `| ${cells.join(' | ')} |`;
 });
 const cite=e=>`${e.type}:${e.source} · ${typeof e.locator==='string'?e.locator:JSON.stringify(e.locator)}`;

 return `# 30 分钟规则审核指南

所有动作均为**建议，非决定**。输入 ${review.counts.candidates} 条候选，
建议合成 ${review.counts.consolidated} 个审核主题（${review.counts.mergeGroups} 组，${review.counts.aliases} 个别名）；
另统计 ${review.counts.formalRules} 条正式规则。原文件保留。

## 审核方法与页面

启动服务后打开 http://127.0.0.1:43128/rules/review 。默认按优先级排序，可切换出现频次，结合来源、状态、aspect 筛选。先用 5 分钟检查下方 gate 例外，
再用 20 分钟每项约 40 秒审 Top 30，最后 5 分钟记录需测量与归并项。

每项先看转述与定位，再看例外及同组相邻帧：是否观察得到、是否影响同组选择、是否可能误杀？不确定就暂缓。measure 只是已有检查方式，代理测量不证明意图；本清单不新增阈值。建议批准保持原 hint，不能升级为 gate。

页面的“批准/修改/合并/删除”才写入已有决定格式，加载建议不会写决定。页面“合并”仅支持人像候选并入现有正式人像规则，**候选间及跨题材建议仅展示，不能通过该按钮执行**；请保留别名待后续实施，不要为完成清单逐条批准。
导出仍为草案，正式库不会改变；其他题材按页面已有独立草案下载。

现有小红书条目在页面属于只读参考；可核对建议与出处，不能点击批准。

## 排序口径

${review.methodology.ranking}

${review.methodology.counts}

衣刀“期/段”是原报告下界（组内最大值），完整报告及档位对比在 JSON 的 frequencyReports。observed 是附带证据去重后的期、段、档位数；代表证据不能代替全量统计，重叠频次和档位不可直接求和。
缺失 kind 的内联证据与 issue/praise 计 source，但保留 originalKind。跨来源一致性只是审核顺序启发式，需人工检验条件是否一致。

## Top 30 待审

支持种类/全部种类；证据数为 source/exception/counterpoint；衣刀期/段为报告下界。表中来源与例外详情查 consolidated-review.json。

| 顺序 | 主条目 | 来源种类 | 证据数 S/E/C | 衣刀期/段 | 检查 / 影响 | 分数 / 建议 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## 建议归并列表

${review.entries.filter(e=>e.aliases.length).map(e=>`- **${e.id}** ← ${e.aliases.join('、')}：${e.mergeReason}`).join('\n')}

归并仅减少审核主题，不删除子项。主 ID 优先选定义较完整或已有稳定引用的条目；全部成员定义、例外与来源保存在 members。姿态拘谨与表情自然只关联 P-POSE-WEIGHT / P-FACE-EXPRESSION，
不能把身体状态与脸部状态视为同一测量。表情变化与姿态序列归并后仍保留两个子项；事件叙事去重与合成源帧整组保留用途不同，后者不可并掉。手臂透视、身体比例、眼白、视线、群像状态与群像层次分别保留。

## 正式规则例外汇总

${review.counts.exceptionGroups} 组、${review.counts.exceptions} 条去重 exception，全部条目在 JSON exceptionGroups.items；
以下每组 1–3 条代表。counterpoint 单独计数，未混入例外。来源定位均沿用现有数据，转述至多 40 字。无 exception 证据的正式规则仍有统计，但不列于此；规则自带 exceptions 不冒计成来源证据。

${review.exceptionGroups.map(g=>`### ${g.ruleId} ${g.title}（${g.severity}，${g.count} 条）

${g.representatives.map(e=>`- ${e.paraphrase} — ${cite(e)}`).join('\n')}`).join('\n\n')}

## 复现

离线执行 \`node scripts/consolidate-rules-review.mjs\`，只重建本指南与 consolidated-review.json。证据新增后应重新生成；不读取或写入 decisions.json。
`;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const review=await buildReview();
 await writeFile(path.join(root,'src/rules/candidates/consolidated-review.json'),JSON.stringify(review,null,2)+'\n');
 await writeFile(path.join(root,'docs/rules-review-guide.md'),renderGuide(review));

 console.log(JSON.stringify(review.counts));
}
