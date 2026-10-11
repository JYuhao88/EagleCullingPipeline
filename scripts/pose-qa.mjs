#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { performance } from 'node:perf_hooks';
import { detectPose } from '../src/core/pose.js';
import { computeSignals } from '../src/core/signals.js';
import { evaluateRules } from '../src/core/rules-engine.js';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key)+1] : fallback;
const run = arg('--run', 'run-1791589678002');
const out = path.resolve(arg('--out', '/tmp/w1-pose-qa'));
const count = Number(arg('--count', '50'));
const data = JSON.parse(await fs.readFile(run.endsWith('.json') ? run : `data/runs/${run}/results.json`, 'utf8'));
const inventory = JSON.parse(await fs.readFile(new URL('../test/fixtures/shantou-20260718-samples.json',
  import.meta.url)));
const unknownFolder = new Set(inventory.folders[0].stems);
const folderMeaning = inventory.folders[0].meaning;
const targets = data.results.filter((r) => r.previewPath && (process.argv.includes('--all-genres') || /^DSC\d+/.test(r.name)));
await fs.mkdir(out, { recursive: true });
const started = performance.now();
const reuse = process.argv.includes('--reuse') ? JSON.parse(await fs.readFile(path.join(out,'all-results.json'),'utf8')) : null;
const rawSaved = reuse ? await fs.readFile(path.join(out,'raw-poses.json'),'utf8').then(JSON.parse).catch(()=>null) : null;
const poses = rawSaved || (reuse ? targets.map(r=> { const old=reuse.results.find(e=>e.unitId===r.unitId); return { ...old.pose,
  id:r.unitId, available:!old.pose.error, persons:old.signals.persons, source:old.signals.source }; }) : await
  detectPose(targets.map((r) => ({ id:r.unitId, filePath:r.previewPath, faces:r.faces })), {size: Math.min(2,
  Number(arg('--concurrency', '1')))}));
await fs.writeFile(path.join(out,'raw-poses.json'),JSON.stringify(poses));
const entries = targets.map((r,i) => {
  const t=performance.now();
  const pose=poses[i];
  const signals=pose?.available ? computeSignals(pose, {source:pose.source}) : {contractVersion:1,persons:[]};
  const verdicts=evaluateRules(signals,{faces:r.faces});
  return {...r,signals,verdicts,pose:{provider:pose?.provider,mode:pose?.mode,timingMs:pose?.timingMs,error:pose?.error,
    fallbackReason:pose?.fallbackReason},signalMs:performance.now()-t};
});
const summary={run,total:entries.length,elapsedMs:reuse?.summary.elapsedMs ?? performance.now()-started,
  averageMs:entries.reduce((a,r)=>a+(r.pose.timingMs?.total||0)+r.signalMs,0)/entries.length,
  unavailable:entries.filter(r=>r.pose.error).length,providers:[...new Set(entries.map(r=>r.pose.provider))]};
await fs.writeFile(path.join(out,'all-results.json'),JSON.stringify({summary,results:entries},null,2));
// Stratify unknown-folder membership, orientation and multi-person. Spread samples
// over filename order within each stratum instead of taking consecutive frames.
const chosen=[];
const add=(r)=>{if(r&&!chosen.includes(r)&&chosen.length<count)chosen.push(r);};
for(const inUnknownFolder of [true,false]) for(const portrait of [true,false]) for(const multi of [true,false]) {
  const bucket=entries.filter(r=>unknownFolder.has(r.name)===inUnknownFolder &&
    (r.signals.source?.proxyHeight>r.signals.source?.proxyWidth)===portrait && (r.signals.persons.length>1)===multi);
  for(let i=0;i<Math.min(6,bucket.length);i++)add(bucket[Math.floor(i*bucket.length/Math.min(6,bucket.length))]);
}
for(const inUnknownFolder of [true,false]) {
  const bucket=entries.filter(r=>unknownFolder.has(r.name)===inUnknownFolder);
  for(let i=0;i<bucket.length;i++)add(bucket[Math.floor(i*37)%bucket.length]);
}
const skeleton=[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],[15,17],[15,18],[15,19],[16,
  20],[16,21],[16,22]];
for(const hand of [91,112])for(const base of [1,5,9,13,17]){skeleton.push([hand,hand+base]);for(let i=0;i<3;
  i++)skeleton.push([hand+base+i,hand+base+i+1]);}
const jointIndices={hairline:[44,45],neck:[5,6],elbow:[7,8],wrist:[9,10],fingers:[95,99,103,107,111,116,120,124,128,132],knee:[13,
  14],ankle:[15,16],foot:[17,18,19,20,21,22]};
const escape=(s)=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const tiles=[];
for(const [i,r] of chosen.entries()) {
  const W=600,H=760,IW=580,IH=570;
  const image=await sharp(r.previewPath).resize(IW,IH,{fit:'inside'}).toBuffer({resolveWithObject:true});
  const ox=(W-image.info.width)/2,oy=8;
  let svg='';
  for(const person of r.signals.persons){
    const p=person.keypoints.points;const xy=(q)=>[ox+q[0]*image.info.width,oy+q[1]*image.info.height];
    const box=person.box;
    svg+=`<rect x="${ox+box[0]*image.info.width}" y="${oy+box[1]*image.info.height}" width="${(box[2]-box[0])*image.info.width}"
      height="${(box[3]-box[1])*image.info.height}" fill="none" stroke="${person.isMain?'#00ff88':'#aaa'}" stroke-width="2"/>`;
    for(const [a,b] of skeleton)if(p[a]?.[2]>=.3&&p[b]?.[2]>=.3){const [x1,y1]=xy(p[a]),[x2,y2]=xy(p[b]);
      svg+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#00eaff" stroke-width="2"/>`;}
    for(const warning of person.edgeAtJoint||[]){
      const indices=jointIndices[warning.joint]||[];
      for(const n of indices){if(!p[n])continue;const [x,y]=xy(p[n]);
        svg+=`<circle cx="${x}" cy="${y}" r="6" stroke="red" fill="none" stroke-width="3"/>`;}
      const edges={top:[ox,oy,ox+image.info.width,oy],bottom:[ox,oy+image.info.height,ox+image.info.width,oy+image.info.height],
        left:[ox,oy,ox,oy+image.info.height],right:[ox+image.info.width,oy,ox+image.info.width,oy+image.info.height]};
      const [x1,y1,x2,y2]=edges[warning.edge];svg+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="red" stroke-width="4"/>`;
    }
  }
  const main=r.signals.persons.find(p=>p.isMain);
  const issues=r.verdicts.filter(v=>v.verdict==='violate');
  const lines=[`${String(i+1).padStart(2,'0')} ${r.name} ${unknownFolder.has(r.name)?'good文件夹(语义未知)':'其他样本'} 人:${r.signals.persons.length}`,
    `景别:${main?.framingTier||'未知'} 主体坏切:${main?.edgeAtJoint?.length||0}`, ...issues.slice(0,4).map(v=>`${v.ruleId} ${v.evidence}`)];
  lines.forEach((line,j)=>svg+=`<text x="12" y="${600+j*26}" font-size="19" fill="${j>1?'#ff7979':'white'}">${escape(line)}</text>`);
  const
    overlay=Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><g font-family="Arial, PingFang
    SC">${svg}</g></svg>`);
  tiles.push(await sharp({create:{width:W,height:H,channels:3,background:'#151515'}}).composite([{input:image.data,
    left:Math.round(ox),top:oy},{input:overlay}]).png().toBuffer());
}
for(let start=0;start<tiles.length;start+=10){const page=tiles.slice(start,start+10);await sharp({create:{width:3000,height:1520,
  channels:3,background:'#111'}}).composite(page.map((input,i)=>({input,left:(i%5)*600,
  top:Math.floor(i/5)*760}))).jpeg({quality:92}).toFile(path.join(out,`contact-${Math.floor(start/10)+1}.jpg`));}
await fs.writeFile(path.join(out,'labels-template.json'),JSON.stringify(chosen.map((r,i)=>({index:i+1,unitId:r.unitId,name:r.name,
  inUnknownFolder:unknownFolder.has(r.name),folderMeaning,previewPath:r.previewPath,
  persons:r.signals.persons.length,signals:r.signals,verdicts:r.verdicts,
  predictedBadCut:r.signals.persons.some(p=>p.isMain&&p.edgeAtJoint?.length>0),humanBadCut:null,humanAgree:null,notes:''})),null,2));
console.log(JSON.stringify({...summary,contacts:Math.ceil(tiles.length/10),labels:chosen.length,out},null,2));
