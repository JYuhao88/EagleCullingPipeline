// Local, read-only real-library sampling. Outputs ONLY to a new temporary folder.
// This is not an accuracy benchmark: no human ground truth is supplied.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EagleApi } from "../src/eagle-api.js";
import { listEagleImages, analyzeImage, applyFaceQuality, hashFile, clusterByPhash } from "../src/image-analyzer.js";
import { FaceWorkerPool } from "../src/face-worker-client.js";
import { ResourceGate } from "../src/resource-gate.js";
import { planCaptureAnalysis } from "../src/plugin/capture-analysis.js";
import { createAnalysisServer } from "../src/server.js";
import { planChunks, uploadTaskPlan } from "../src/plugin/task-plan-upload.js";

const includeSemantic = process.argv.includes("--semantic");
const adjacentSample = process.argv.includes("--adjacent");
const highQualityPreviews = process.argv.includes("--high-quality");
const perFormatIndex = process.argv.indexOf("--per-format");
const perFormat = perFormatIndex < 0 ? 5 : Number(process.argv[perFormatIndex+1]);
if (!Number.isSafeInteger(perFormat) || perFormat < 1) throw new Error("--per-format requires a positive integer");
const progress = (phase, completed, total) => console.error(JSON.stringify({phase,completed,total}));

const api = new EagleApi();
const library = await api.libraryInfo();
const catalogue = await listEagleImages(library.path);
const byId = new Map(catalogue.map(item=>[item.id,item]));
const selected = ["jpg","arw","heic","3fr"].flatMap(ext => {
  const items = catalogue.filter(item=>item.ext.toLowerCase()===ext).sort((a,b)=>a.id.localeCompare(b.id));
  if (adjacentSample) {
    const folders=new Map();
    for(const item of items) {const key=JSON.stringify([...(item.folders || [])].sort());if(!folders.has(key)) folders.set(key,[]);folders.get(key).push(item);}
    const cohort=[...folders.values()].sort((a,b)=>b.length-a.length)[0] || [];
    return cohort.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}) || a.id.localeCompare(b.id)).slice(0,perFormat);
  }
  return Array.from({length:Math.min(perFormat,items.length)},(_,index)=>items[Math.floor(index*items.length/Math.min(perFormat,items.length))]);
});
if (!selected.length) throw new Error("No sample images found in the current Eagle library");
const outputRoot = await mkdtemp(path.join(os.tmpdir(),"eagle-real-analysis-"));
const gate = new ResourceGate({concurrency:2});
sharp.concurrency(2);
const facePool = new FaceWorkerPool({size:2});
const metadataPath = item => path.join(path.dirname(item.filePath),"metadata.json");
const jobs = planCaptureAnalysis(catalogue,selected);
// Also protect unselected JPEG/HEIC sources used to analyze a selected RAW.
const protectedItems = [...new Map([...selected,...jobs.map(job=>byId.get(job.result.analysisPlan.sourceId))].map(item=>[item.id,item])).values()];
const before = new Map();
progress("hash-before",0,protectedItems.length);
for (const item of protectedItems) {
  before.set(item.id, {original:(await hashFile(item.filePath)).sha256,metadata:await readFile(metadataPath(item),"utf8")});
  if (before.size % 25 === 0 || before.size === protectedItems.length) progress("hash-before",before.size,protectedItems.length);
}
let sampledPeakRss = process.memoryUsage().rss;
const timer = setInterval(()=>{sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);},20);
const started = performance.now();
let cpuBefore = process.cpuUsage();
let results;
let semanticReport;
let isolatedService;
try {
  if (includeSemantic) {
    isolatedService = createAnalysisServer({port:0,taskStorePath:path.join(outputRoot,"tasks.json"),modelPreviewRoot:path.join(outputRoot,"model-previews"),semanticWorkerOptions:{cacheRoot:path.join(outputRoot,"semantic-cache")},nativeImageThreads:2});
    await isolatedService.listen();
    const base=`http://127.0.0.1:${isolatedService.server.address().port}`;
    const request=async(endpoint,body)=>{
      const response=await fetch(base+endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
      const payload=await response.json();if(!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);return payload;
    };
    const inputs=jobs.map(job=>{const source=byId.get(job.result.analysisPlan.sourceId);return {...source,analysisPath:source.thumbnailPath || source.filePath};});
    const analyzeBatch = async phase => {
      const items=[];
      // Bound each connection's work, not the total sample size. Reuse the
      // same model pools and cache across all requests.
      const batches=planChunks(inputs).flatMap(chunk=>Array.from({length:Math.ceil(chunk.items.length/32)},(_,index)=>chunk.items.slice(index*32,(index+1)*32)));
      for (const batchItems of batches) {
        const batch = await request("/analyze",{items:batchItems,includeFaces:true,includeEmbeddings:true,highQualityPreviews});
        items.push(...batch.items);
        progress(phase,items.length,inputs.length);
      }
      return {items};
    };
    const coldAt=performance.now();
    const cold=await analyzeBatch("cold-analysis");
    const coldMs=Math.round(performance.now()-coldAt),warmAt=performance.now();
    const warm=await analyzeBatch("warm-analysis");
    const warmMs=Math.round(performance.now()-warmAt);
    const clusterAt=performance.now();
    // Full vector payloads can exceed /cluster's HTTP body budget. Persist
    // only derived results in this isolated temporary service, then cluster
    // the whole sample by reference, not disconnected per-batch groups.
    const saved=await uploadTaskPlan(async(endpoint,options)=>{
      if (options?.method === "POST") return request(endpoint,JSON.parse(options.body));
      const response=await fetch(base+endpoint);return response.json();
    },{taskType:"readonly-audit-results",libraryPath:library.path,activationPending:true,items:cold.items.map(result=>({id:result.id,status:"succeeded",result}))});
    const clustered=await request("/cluster",{taskId:saved.taskId,includeEmbeddings:true});
    const diagnostics=await (await fetch(base+"/diagnostics")).json();
    semanticReport={coldMs,warmMs,clusteringMs:Math.round(performance.now()-clusterAt),semantic:clustered.semantic,groups:clustered.groups,diagnostics,
      repeatedVectorsIdentical:cold.items.every((item,index)=>item.embedding && JSON.stringify(item.embedding)===JSON.stringify(warm.items[index]?.embedding))};
    results=cold.items.map((item,index)=>({...item,sourceId:inputs[index].id,memberIds:jobs[index].result.analysisPlan.members.map(member=>member.id)}));
  } else {
  results = await Promise.all(jobs.map(async job => {
    const plan = job.result.analysisPlan;
    const source = byId.get(plan.sourceId);
    const analysisPath = source.thumbnailPath || source.filePath;
    const input = {...source,analysisPath};
    const at = performance.now();
    try {
      const result = await gate.run(()=>analyzeImage(input));
      const [face] = await facePool.run([{id:source.id,filePath:analysisPath}]);
      const merged = applyFaceQuality(result,face);
      const preview = await sharp(analysisPath).metadata();
      return {...merged,sourceId:source.id,memberIds:plan.members.map(item=>item.id),previewWidth:preview.width,previewHeight:preview.height,elapsedMs:Math.round(performance.now()-at)};
    } catch(error) { return {id:source.id,memberIds:plan.members.map(item=>item.id),error:error.message}; }
  }));
  }
} finally { clearInterval(timer);facePool.close();gate.close();if(isolatedService) await new Promise(resolve=>isolatedService.server.close(resolve)); }
const analysisMs = Math.round(performance.now()-started);
const cpu = process.cpuUsage(cpuBefore);
const verification = [];
progress("hash-after",0,protectedItems.length);
for (const item of protectedItems) {
verification.push({id:item.id,ext:item.ext,
  originalSha256Unchanged:(await hashFile(item.filePath)).sha256===before.get(item.id).original,
  metadataBytesUnchanged:await readFile(metadataPath(item),"utf8")===before.get(item.id).metadata});
if (verification.length % 25 === 0 || verification.length === protectedItems.length) progress("hash-after",verification.length,protectedItems.length);
}
const report = {createdAt:new Date().toISOString(),libraryPath:library.path,selectedFiles:selected.length,
  samplingMethod:adjacentSample ? "first-n-by-name-in-largest-folder-per-format" : "spread-by-id-per-format",perFormat,
  highQualityPreviews,
  formats:Object.fromEntries(["jpg","arw","heic","3fr"].map(ext=>[ext,selected.filter(item=>item.ext.toLowerCase()===ext).length])),
  analysisUnits:jobs.length,analysisMs,nodeCpuMs:Math.round((cpu.user+cpu.system)/1000),sampledNodePeakRssMiB:Math.round(sampledPeakRss/1024**2),
  facesAvailable:results.filter(item=>item.face?.available===true).length,totalDetectedFaces:results.reduce((sum,item)=>sum+(item.face?.faceCount||0),0),
  failed:results.filter(item=>item.error).length,verification,groups:clusterByPhash(results.filter(item=>item.phash)),results,semanticReport,
  caveats:["No Eagle mutations. Metadata bytes and originals verified only for the selected sample.","Node CPU/RSS exclude Python model processes; 20ms samples may miss peaks.","Existing thumbnails may still contain legacy badges; no ground-truth accuracy claim.","Uses real Eagle previews, not full RAW decoding or a full-library throughput test."]};
await writeFile(path.join(outputRoot,"report.json"),JSON.stringify(report,null,2),"utf8");
console.log(JSON.stringify({...report,results:undefined,groups:undefined,verification:undefined,
  semanticReport:semanticReport ? {...semanticReport,groups:undefined} : undefined,
  unchangedOriginals:verification.filter(item=>item.originalSha256Unchanged).length,unchangedMetadata:verification.filter(item=>item.metadataBytesUnchanged).length,
  reportPath:path.join(outputRoot,"report.json")},null,2));
if (report.failed || verification.some(item=>!item.originalSha256Unchanged || !item.metadataBytesUnchanged) || includeSemantic && (semanticReport.semantic?.available !== jobs.length || !semanticReport.repeatedVectorsIdentical)) process.exitCode = 1;
