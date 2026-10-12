// Local real-unit cold run. Launch via bench-performance.py under the shared lock.
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {AnalysisPipeline} from '../src/core/pipeline.js';
import {ResultsStore} from '../src/core/results-store.js';
import {RunProgress} from '../src/core/run-progress.js';
import {buildCaptureUnits} from '../src/core/capture-units.js';

const [mode, label, runId = 'run-1791546991006'] = process.argv.slice(2);
if (!['old','normal','turbo'].includes(mode) || !/^[a-z0-9-]+$/.test(label || '') || !/^run-[a-zA-Z0-9_-]+$/.test(runId))
  throw new Error('Pass old|normal|turbo, unique label, and optional source run ID');
const cacheRoot = path.resolve('data/cache/w23-threads/e2e', label);
try { await readFile(path.join(cacheRoot,'started.json')); throw new Error('Cold run label already used'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
await mkdir(cacheRoot,{recursive:true});
await writeFile(path.join(cacheRoot,'started.json'),JSON.stringify({mode,runId,date:new Date().toISOString()}));
const state = JSON.parse(await readFile(path.join('data/runs',runId,'results.json'),'utf8'));
const units = buildCaptureUnits(state.items).slice(0,38);
if (units.length < 30) throw new Error('Need at least thirty real units');
const byId = new Map(state.items.map(item => [item.id,item]));
const records = units.map(unit => ({...byId.get(unit.primaryItemId),unitId:unit.id,itemIds:unit.itemIds,
  pairedItems:unit.itemIds.map(id => byId.get(id))}));
const inputSha256 = {};
for (const item of state.items.filter(item => units.some(unit => unit.itemIds.includes(item.id)))) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(item.filePath || item.path)) digest.update(chunk);
  inputSha256[item.id] = digest.digest('hex');
}
const tracker = new RunProgress();
let stage;
const stageMemory = [];
const stagePeakMemory = {};
const memoryTimer = setInterval(() => {
  if (!stage) return;
  const memory = process.memoryUsage();
  if (!stagePeakMemory[stage] || memory.rss > stagePeakMemory[stage].memory.rss)
    stagePeakMemory[stage] = {memory,sharpCache:sharp.cache()};
}, 100);
memoryTimer.unref();
const onProgress = progress => { tracker.update(progress); if(stage!==progress.stage){stage=progress.stage;
  stageMemory.push({stage, memory:process.memoryUsage(), sharpCache:sharp.cache()});
  console.log(JSON.stringify({stage,elapsed:tracker.last.elapsedSeconds,memory:stageMemory.at(-1)}));} };
const pipeline = new AnalysisPipeline({concurrency:2,cacheRoot,store:new ResultsStore(cacheRoot)});
const started = performance.now();
let result;
try { result = await pipeline.run(records,{performanceMode:mode==='turbo'?'turbo':'normal',onProgress}); }
catch(error) {
  clearInterval(memoryTimer);
  await writeFile(path.join(cacheRoot,'failure.json'),JSON.stringify({status:'failed',reason:error.message,
    progress:tracker.last,stageMemory,stagePeakMemory}));
  console.error(JSON.stringify({status:'failed',reason:error.message}));
  process.exit(1);
}
clearInterval(memoryTimer);
onProgress(result.progress);
const report = {mode,sourceRun:runId,units,inputSha256,wallSeconds:(performance.now()-started)/1000,
  progress:tracker.last,stageMemory,stagePeakMemory,groups:result.groups,results:result.results,warnings:result.warnings,
  poseThreads:[...new Set(result.results.map(r=>r.pose?.diagnostics?.intraOpThreads?.pose))]};
await writeFile(path.join(cacheRoot,'result.json'),JSON.stringify(report));
console.log(JSON.stringify({mode,label,wallSeconds:report.wallSeconds,units:units.length,groups:result.groups.length,
  stageDurationsMs:tracker.last.stageDurationsMs,poseThreads:report.poseThreads,warnings:report.warnings}));
// Model sessions and idle exiftool timers do not belong to the measured run.
process.exit(0);
