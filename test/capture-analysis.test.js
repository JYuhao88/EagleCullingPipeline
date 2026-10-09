import assert from "node:assert/strict";
import test from "node:test";
import { planCaptureAnalysis, materializeCaptureAnalysis, overlayCachedAnalysis, readCaptureAnalysisContext } from "../src/plugin/capture-analysis.js";
import { buildReviewSections } from "../src/plugin/review-model.js";
import { SCORING_VERSION } from "../src/plugin/analysis-version.js";

const pair = [
  {id:"raw",name:"DSC1",ext:"arw",modifiedAt:1,folders:["trip"],width:8000,height:6000,tags:["人工RAW"],star:4},
  {id:"jpg",name:"DSC1",ext:"jpg",modifiedAt:2,folders:["trip"],width:4000,height:3000,tags:["人工JPG"],star:2},
];
test("one analysis unit for a pair, preferring preview even when only RAW selected", () => {
  const entries = planCaptureAnalysis(pair,pair);
  assert.equal(entries.length,1);
  assert.equal(entries[0].result.analysisPlan.sourceId,"jpg");
  assert.equal(entries[0].result.analysisPlan.members.length,2);
  const rawOnly = planCaptureAnalysis(pair,[pair[0]]);
  assert.equal(rawOnly[0].result.analysisPlan.sourceId,"jpg");
  assert.equal(rawOnly[0].result.analysisPlan.members.length,1);
  const ambiguous = [...pair,{...pair[1],id:"jpg2",folders:["other"]}];
  assert.equal(planCaptureAnalysis(ambiguous,pair).length,2);
  assert.equal(planCaptureAnalysis(ambiguous,[pair[0]])[0].result.analysisPlan.sourceId,"raw");
});
test("shared scores never copy preview dimensions, stars, tags or folders into RAW", () => {
  const plan = planCaptureAnalysis(pair,pair)[0].result.analysisPlan;
  const result = {...pair[1],phash:"1234",qualityScore:88,qualityFlags:["overexposed"],metrics:{clippedHigh:0.1},analysisSource:"proxy"};
  const records = materializeCaptureAnalysis(result,pair,"jpg",plan);
  const raw = records.find(item=>item.id==="raw");
  assert.equal(raw.width,8000);assert.equal(raw.height,6000);assert.equal(raw.star,4);
  assert.deepEqual(raw.tags,["人工RAW"]);assert.deepEqual(raw.folders,["trip"]);
  assert.equal(raw.qualityScore,88);assert.equal(raw.analysisSource,"paired-proxy");
  assert.equal(records.find(item=>item.id==="jpg").analysisSource,"proxy");
});
test("similarity grouping counts capture units and displays their paired files", () => {
  const second = pair.map(item=>({...item,id:item.id+"2",name:"DSC2"}));
  const items = [...pair,...second];
  const group = {groupId:"phash-1",size:2,representativeId:"raw",items:[{id:"raw"},{id:"raw2"}]};
  const section = buildReviewSections(items,[group])[0];
  assert.equal(section.records.length,4);
  assert.equal(section.records.find(item=>item.id==="jpg").recommendation,"selected");
  assert.equal(section.records.find(item=>item.id==="jpg2").recommendation,"rejected");
  assert.ok(section.note.includes("2 个分析单元 · 4 个文件"));
});
test("8000 paired files create 4000 jobs without a total-count cap", () => {
  const items = Array.from({length:4000},(_,index)=>pair.map(item=>({...item,id:item.id+index,name:"DSC"+index}))).flat();
  const jobs = planCaptureAnalysis(items,items);
  assert.equal(jobs.length,4000);
  assert.equal(jobs.flatMap(item=>item.result.analysisPlan.members).length,8000);
});

test("resumed analysis preserves current human metadata and marks obsolete cached results", () => {
  const current = {...pair[0],modifiedAt:3,tags:["人工新标签"],star:5,name:"新名称"};
  const cached = {...pair[0],qualityScore:90,phash:"1234",analysisSource:"paired-proxy",analysisSourceId:"jpg"};
  const result = overlayCachedAnalysis(current,cached);
  assert.equal(result.star,5);assert.equal(result.name,"新名称");
  assert.deepEqual(result.tags,["人工新标签"]);assert.equal(result.analysisStale,true);
  assert.equal(result.qualityScore,90);
  const record = buildReviewSections([result],[{groupId:"phash-1",size:2,representativeId:result.id,items:[{id:result.id}]}])[0].records[0];
  assert.equal(record.recommendation,"candidate");
  assert.ok(record.reasons[0].includes("缓存分析早于"));
});

test("algorithm upgrades invalidate cached recommendations without changing human decisions", () => {
  const current = {...pair[1],tags:["人工标签","AI精选"]};
  for (const scoringVersion of [undefined,"preview-v1"]) {
    const result = overlayCachedAnalysis(current,{...current,scoringVersion,qualityScore:99});
    assert.equal(result.analysisStale,true);
    assert.deepEqual(result.analysisStaleReasons,["scoring-version"]);
    const record = buildReviewSections([result])[0].records[0];
    assert.equal(record.state,"selected");
    assert.equal(record.recommendation,"candidate");
    assert.ok(record.reasons[0].includes("评分算法已更新"));
    assert.deepEqual(record.tags,current.tags);
  }
  assert.equal(overlayCachedAnalysis(current,{...current,scoringVersion:SCORING_VERSION}).analysisStale,false);
});

test("cached RAW scores depend on their preview source, not only the unchanged RAW", () => {
  const plan = planCaptureAnalysis(pair,pair)[0].result.analysisPlan;
  const cached = materializeCaptureAnalysis({...pair[1],scoringVersion:SCORING_VERSION,qualityScore:90},pair,"jpg",plan)[0];
  assert.equal(cached.analysisSourceModifiedAt,2);
  assert.equal(overlayCachedAnalysis(pair[0],cached,pair[1]).analysisStale,false);
  for (const source of [undefined,{...pair[1],modifiedAt:3}]) {
    const result = overlayCachedAnalysis(pair[0],cached,source);
    assert.deepEqual(result.analysisStaleReasons,["source-modified"]);
    const record = buildReviewSections([result])[0].records[0];
    assert.equal(record.recommendation,"candidate");
    assert.ok(record.reasons[0].includes("配对分析来源"));
    assert.equal(record.star,4);
  }
});

test("post-inference reads detect edits and deletion without retaining pre-inference Items", async () => {
  let catalogue = structuredClone(pair);
  const plan = planCaptureAnalysis(catalogue,catalogue)[0].result.analysisPlan;
  const readItem = async (id) => catalogue.find(item=>item.id===id);
  const before = await readCaptureAnalysisContext(plan,readItem);
  assert.equal(before.error,null);
  catalogue = catalogue.map(item=>item.id==="raw" ? {...item,modifiedAt:10,tags:["人工更新"],star:5} : item);
  const after = await readCaptureAnalysisContext(plan,readItem);
  assert.ok(after.error.includes("已修改"));
  assert.deepEqual(after.members[0].tags,["人工更新"]);
  assert.equal(after.members[0].star,5);
  assert.deepEqual(before.members[0].tags,["人工RAW"]);
  catalogue = catalogue.filter(item=>item.id!=="jpg");
  assert.ok((await readCaptureAnalysisContext(plan,readItem)).error.includes("缺失"));
});
