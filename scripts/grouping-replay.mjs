// Replay saved model outputs; reads neither Eagle nor originals.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { groupResultsAsync, recallCrossDayDuplicates, readCaptureTimes } from '../src/core/grouping.js';
const [input='/tmp/w2-gate2-qa/final-analyze.json', output='/tmp/w6-grouping-replay.json',
  ref='7bc228a324f2919ac888e38612b11c8cd1e33722'] = process.argv.slice(2);
const state=JSON.parse(await readFile(input,'utf8'));
const folder=await mkdtemp('/tmp/w6-group-replay-');
try {
  const source=execFileSync('git',['show',`${ref}:src/core/grouping.js`],{encoding:'utf8'});
  const baselineFile=path.join(folder,'baseline.mjs');
  await writeFile(baselineFile,source.replace('"./metrics.js"',JSON.stringify(pathToFileURL(path.resolve('src/core/metrics.js')).href)));
  const baseline=await import(pathToFileURL(baselineFile));
  const records=state.results.filter(result=>String(result.name || '').startsWith('DSC'));
  const before=baseline.groupResults(records);
  const replayRecords=records.map(record=>({...record}));
  if (process.argv.includes('--fresh-exif')) {
    const byId=new Map(state.items.map(item=>[item.id,item]));
    const units=new Map(state.units.map(unit=>[unit.id,unit]));
    for (const record of replayRecords) {
      record.filePath=byId.get(units.get(record.unitId)?.primaryItemId)?.filePath;
      delete record.captureTime;
      delete record.sessionId;
    }
    await readCaptureTimes(replayRecords);
  }
  const after=await groupResultsAsync(replayRecords);
  const pairs=groups=>new Set(groups.flatMap(g=>g.unitIds.flatMap((a,i)=>g.unitIds.slice(i+1).map(b=>[a,b].sort().join('|')))));
  const left=pairs(before),right=pairs(after);
  const stats=groups=>({groups:groups.length,maxGroupSize:Math.max(...groups.map(g=>g.size)),members:groups.map(g=>g.unitIds)});
  const sameInput=pairs(baseline.groupResults(replayRecords));
  const report={input,baselineRef:ref,freshExif:process.argv.includes('--fresh-exif'),units:records.length,
    before:stats(before),after:stats(after),
    sameInputAddedPairs:[...right].filter(p=>!sameInput.has(p)),
    sameInputRemovedPairs:[...sameInput].filter(p=>!right.has(p)),
    addedPairs:[...right].filter(p=>!left.has(p)),removedPairs:[...left].filter(p=>!right.has(p)),
    crossDayCandidates:Object.fromEntries(await recallCrossDayDuplicates(replayRecords))};
  await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,before:{...report.before,members:undefined},after:{...report.after,members:undefined}}));
} finally {await rm(folder,{recursive:true,force:true});}
