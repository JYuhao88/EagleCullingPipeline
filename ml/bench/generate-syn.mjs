#!/usr/bin/env node
// Offline paired corruptions: no aesthetic/user labels and no Eagle writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { detectPose } from '../../src/core/pose.js';
import { candidatePerson, CANDIDATE_CONFIG } from '../../src/core/candidate-measurements.js';
sharp.concurrency(1);
sharp.cache(false);
const sha = b => createHash('sha256').update(b).digest('hex');
const root = path.resolve('data/cache/bench/syn');
const count = Number(process.env.BENCH_SOURCES_PER_ORIGIN || 10);
const runPath = process.argv[2] || 'data/runs/run-1791589678002/results.json';
if (process.argv.includes('--w5')) {
  await generateW5();
  process.exit(0);
}
const run = JSON.parse(await fs.readFile(runPath));
const manifest = {version: 1, benchmark: 'T-syn', generatedAt: new Date().toISOString(), sourceRun: runPath,
  protocol: {selection: 'Objective technical thresholds followed by evenly spaced stems, independent of score/flags and unknown folders',
    thresholds: {sharpnessMin: .08, exposureMin: .4, clippedHighlightsMax: .025, clippedShadowsMax: .05},
    seed: 20260718, size: 1024, jpegQuality: 95, gatePolicy: 'Only severe blur, noise and exposure are mandatory reject cases; composition is preference-only.',
    caveats: ['Injected rotation has no annotated natural horizon.', 'Source expected preference is a corruption prior, not human aesthetic truth.', 'Keypoints are model-derived with confidence >= .6; neck is estimated midpoint of shoulders.']},
  sources: [], pairs: [], skipped: []};
await fs.mkdir(root, {recursive:true});
const candidates=[];
for(const origin of ['shantou','eagle38']) {
  const eligible=run.results.filter(x => (x.name.startsWith('DSC')?'shantou':'eagle38')===origin && !x.previewPath.includes('未删减') && x.metrics.sharpness>=.08 && x.metrics.exposure>=.4 && x.metrics.clippedHighlights<=.025 && x.metrics.clippedShadows<=.05).sort((a,b)=>a.name.localeCompare(b.name));
  const n=Math.min(count,eligible.length);
  for(let i=0;i<n;i++) candidates.push({...eligible[Math.floor(i*eligible.length/n)],origin});
}
for(const [index,c] of candidates.entries()) {
  const id=`s${String(index+1).padStart(3,'0')}`;
  const buf=await sharp(c.previewPath).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:95}).toBuffer();
  await fs.writeFile(path.join(root,`${id}.jpg`),buf);
  const meta=await sharp(buf).metadata();
  manifest.sources.push({id,sourceStem:c.name,path:`${id}.jpg`,origin:c.origin,sha256:sha(buf),width:meta.width,height:meta.height,selectionMetrics:c.metrics,faces:c.faces||[]});
}
console.log(`Selected ${manifest.sources.length} sources. Inferring pose with one CPU worker.`);
const poses=await detectPose(manifest.sources.map(s=>({id:s.id,filePath:path.join(root,s.path),faces:s.faces})), {size:1});
const poseById=new Map(poses.map(p=>[p.id,p]));
await fs.writeFile(path.join(root,'pose.json'),JSON.stringify(poses,null,2)+'\n');
// Deterministic PRNG; per-image independent seed means adding cases cannot change existing noise.
function rng(seed) {let x=seed>>>0;return ()=> {x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
const srgbToLinear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
const linearToSrgb=x=>x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055;
for(const s of manifest.sources) {
 const input=await fs.readFile(path.join(root,s.path));
 const {data:raw,info}=await sharp(input).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const w=info.width,h=info.height;
 const add=async(degradation,strength,image,extra={})=>{
   const id=`${s.id}-${degradation}-${String(strength).replace(/[^\w.-]/g,'_')}`;
   // Match source JPEG codec/quality on every case.
   const transformed=await image.png().toBuffer();
   const buf=await sharp(transformed).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:95}).toBuffer();
   await fs.writeFile(path.join(root,`${id}.jpg`),buf);
   manifest.pairs.push({id,degradedId:id,sourceId:s.id,sourceStem:s.sourceStem,path:`${id}.jpg`,degradation,strength,expectedWinner:'source',sha256:sha(buf),...extra});
 };
 for(const sigma of [1,3,6]) await add('defocus-blur',sigma,sharp(input).blur(sigma),{...(sigma===6?{expectedGate:true}:{}),unit:'sigma-px'});
 for(const length of [9,21,41]) {
   const out=Buffer.alloc(raw.length);
   const r=(length-1)/2;
   for(let y=0;y<h;y++)for(let ch=0;ch<3;ch++){
     let total=0;for(let dx=-r;dx<=r;dx++)total+=raw[(y*w+Math.max(0,Math.min(w-1,dx)))*3+ch];
     for(let x=0;x<w;x++){out[(y*w+x)*3+ch]=Math.round(total/length);total-=raw[(y*w+Math.max(0,x-r))*3+ch];total+=raw[(y*w+Math.min(w-1,x+r+1))*3+ch];}
   }
   await add('motion-blur',length,sharp(out,{raw:info}),{...(length===41?{expectedGate:true}:{}),unit:'horizontal-kernel-px'});
 }
 for(const ev of [-2.5,-1.5,1.5,2.5]) {
   const lut=Array.from({length:256},(_,i)=>Math.round(255*linearToSrgb(Math.min(1,srgbToLinear(i/255)*2**ev))));
   const out=Buffer.from(raw.map(v=>lut[v]));
   await add(ev<0?'underexposure':'overexposure',ev,sharp(out,{raw:info}),{...(Math.abs(ev)===2.5?{expectedGate:true}:{}),unit:'linear-light-EV'});
 }
 for(const sigma of [25,50]){
   const random=rng(20260718+Number(s.id.slice(1))),out=Buffer.from(raw);
   for(let i=0;i<out.length;i++) {const z=Math.sqrt(-2*Math.log(Math.max(1e-9,random())))*Math.cos(2*Math.PI*random());out[i]=Math.max(0,Math.min(255,Math.round(raw[i]+sigma*z)));}
   await add('noise',sigma,sharp(out,{raw:info}),{...(sigma===50?{expectedGate:true}:{}),unit:'Gaussian-sRGB-sigma'});
 }
 for(const angle of [3,8]){
   const rotated=await sharp(input).rotate(angle,{background:'#808080'}).toBuffer();
   const m=await sharp(rotated).metadata();
   await add('horizon-tilt',angle,sharp(rotated).extract({left:Math.floor((m.width-w)/2),top:Math.floor((m.height-h)/2),width:w,height:h}),{unit:'degrees',note:'Rotation injection; no ground-truth horizon'});
 }
 await add('excess-headroom',.5,sharp(input).extend({top:Math.round(h*.5),bottom:0,left:0,right:0,background:'#808080'}),{unit:'fraction-of-source-height',note:'Neutral added canvas; may create edge artifacts'});
 if(s.faces.length) {
   const face=s.faces[0].box;
   const top=Math.max(1,Math.min(h-2,Math.round(face[1]*h+(face[3]-face[1])*h*.2)));
   await add('head-top-crop',.2,sharp(input).extract({left:0,top,width:w,height:h-top}),{crop:{left:0,top,width:w,height:h-top},evidence:{faceBox:face}});
   const out=Buffer.from(raw),[x0,y0,x1,y1]=face;
   for(let y=Math.max(0,Math.floor(y0*h));y<Math.min(h,Math.ceil(y1*h));y++)for(let x=Math.max(0,Math.floor(x0*w));x<Math.min(w,Math.ceil(x1*w));x++)for(let ch=0;ch<3;ch++){const i=(y*w+x)*3+ch;out[i]=Math.round(255*linearToSrgb(Math.min(1,srgbToLinear(raw[i]/255)*2**2.5)));}
   let clipped=0,total=0;
   for(let y=Math.max(0,Math.floor(y0*h));y<Math.min(h,Math.ceil(y1*h));y++)for(let x=Math.max(0,Math.floor(x0*w));x<Math.min(w,Math.ceil(x1*w));x++){const i=(y*w+x)*3;total++;if(.2126*out[i]+.7152*out[i+1]+.0722*out[i+2]>=250)clipped++;}
   const clippedFaceFraction=clipped/total;
   await add('face-highlight-clipping',2.5,sharp(out,{raw:info}),{...(clippedFaceFraction>=.1?{expectedGate:true}:{}),unit:'localized-linear-light-EV',evidence:{faceBox:face,clippedFaceFraction,mandatoryGateMinimum:.1}});
 } else manifest.skipped.push({sourceId:s.id,degradation:'head/face',reason:'No face detection in source run'});
 const pose=poseById.get(s.id),person=pose?.persons?.find(p=>p.isMain),points=person?.keypoints?.points;
 if(points){
   s.pose={provider:pose.provider,mainPersonScore:person.score};
   const joints=[['wrist',(points[9]?.[2]||0)>=(points[10]?.[2]||0)?9:10],['knee',(points[13]?.[2]||0)>=(points[14]?.[2]||0)?13:14],['ankle',(points[15]?.[2]||0)>=(points[16]?.[2]||0)?15:16]];
   const neck=points[5]?.[2]>=.6&&points[6]?.[2]>=.6 ? [(points[5][0]+points[6][0])/2,(points[5][1]+points[6][1])/2,Math.min(points[5][2],points[6][2])] : null;
   for(const [joint,keypoint] of [...joints,['neck',-1]]){
     const p=keypoint===-1?neck:points[keypoint];
     if(!p||p[2]<.6||p[1]<.1||p[1]>.95){manifest.skipped.push({sourceId:s.id,degradation:`joint-crop-${joint}`,reason:'No confident in-frame joint'});continue;}
     const bottom=Math.round(p[1]*h);
     await add(`joint-crop-${joint}`,1,sharp(input).extract({left:0,top:0,width:w,height:bottom}),{crop:{left:0,top:0,width:w,height:bottom},evidence:{keypoint,keypointNormalized:p,confidenceThreshold:.6,neckEstimated:joint==='neck'}});
   }
 } else manifest.skipped.push({sourceId:s.id,degradation:'joint-crops',reason:pose?.error?.message||'No main person detected'});
 console.log(`${s.id} ${s.origin} ${s.sourceStem}: generated, ${manifest.pairs.length} total pairs`);
}
manifest.images=[...manifest.sources,...manifest.pairs].map(({id,path,sha256})=>({id,path,sha256}));
await fs.writeFile('test/fixtures/bench-syn-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({sources:manifest.sources.length,pairs:manifest.pairs.length,skipped:manifest.skipped.length,types:Object.fromEntries([...new Set(manifest.pairs.map(p=>p.degradation))].map(t=>[t,manifest.pairs.filter(p=>p.degradation===t).length]))},null,2));

// Appends only; the original 368 pairs and JPEG bytes remain immutable.
async function generateW5() {
 const manifestPath='test/fixtures/bench-syn-manifest.json';
 const original=JSON.parse(await fs.readFile(manifestPath));
 const m=structuredClone(original), poses=JSON.parse(await fs.readFile(path.join(root,'pose.json')));
 m.version=2; m.parentManifestSha256=sha(await fs.readFile(manifestPath));
 m.protocol.w5={purpose:'Sensitivity to controlled pixel changes, not aesthetic truth',
  modelPolicy:'Source pose/faces reused; no models invoked',
  personValidity:CANDIDATE_CONFIG.person,strengths:CANDIDATE_CONFIG.synthetic};
 const synConfig=CANDIDATE_CONFIG.synthetic;
 for(const s of m.sources){
  const input=await fs.readFile(path.join(root,s.path));
  if(sha(input)!==s.sha256)throw new Error(`Source checksum mismatch ${s.id}`);
  const {data,info}=await sharp(input).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const person=candidatePerson(poses.find(p=>p.id===s.id));
  const reliable=Boolean(person);
  const box=person?.box;
  for(const strength of ['mild','severe']){
   for(const degradation of ['tonal-gray','nonface-highlights','bg-separation']){
    if(degradation!=='tonal-gray'&&!reliable){m.skipped.push({sourceId:s.id,degradation,reason:'No main person with reliable side-sampleable person per W5 eligibility'});continue;}
    const out=Buffer.from(data), w=info.width,h=info.height;
    let target=0, clipped=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
     const i=(y*w+x)*3,nx=x/w,ny=y/h;
     if(degradation==='tonal-gray'){
      const factor=synConfig.tonalScale[strength];
      for(let c=0;c<3;c++)out[i+c]=Math.round(CANDIDATE_CONFIG.synthetic.tonalCenter+(data[i+c]-CANDIDATE_CONFIG.synthetic.tonalCenter)*factor);
     }else if(degradation==='nonface-highlights'){
      const inside=nx>box[0]&&nx<box[2]&&ny>box[1]&&ny<box[3];
      const face=s.faces.some(f=>nx>f.box[0]&&nx<f.box[2]&&ny>f.box[1]&&ny<f.box[3]);
      // Lower torso patch avoids face and typical sky; preserves pose geometry.
      const patch=ny>box[1]+(box[3]-box[1])*synConfig.highlightPatchStart&&ny<box[1]+(box[3]-box[1])*synConfig.highlightPatchEnd[strength];
      if(inside&&!face&&patch){target++;for(let c=0;c<3;c++)out[i+c]=Math.min(255,data[i+c]+synConfig.highlightAddition[strength]);if(Math.min(out[i],out[i+1],out[i+2])>=250)clipped++;}
     }else{
      const edge=Math.min(Math.abs(nx-box[0]),Math.abs(nx-box[2]));
      const vertical=ny>box[1]+synConfig.verticalMargin*(box[3]-box[1])&&ny<box[3]-synConfig.verticalMargin*(box[3]-box[1]);
      const width=(box[2]-box[0])*synConfig.edgeWidth;
      if(vertical&&edge<width){
       // Equalize inside/outside side bands with the same local interior row color.
       const sx=Math.max(0,Math.min(w-1,Math.round((Math.abs(nx-box[0])<Math.abs(nx-box[2])?box[0]+width:box[2]-width)*w)));
       const mix=synConfig.edgeMix[strength];
       for(let c=0;c<3;c++)out[i+c]=Math.round(data[i+c]*(1-mix)+data[(y*w+sx)*3+c]*mix);
       target++;
      }
     }
    }
    const id=`${s.id}-${degradation}-${strength}`;
    const buf=await sharp(out,{raw:info}).jpeg({quality:95}).toBuffer();
    await fs.writeFile(path.join(root,`${id}.jpg`),buf);
    m.pairs.push({id,degradedId:id,sourceId:s.id,sourceStem:s.sourceStem,path:`${id}.jpg`,degradation,strength,expectedWinner:'source',sha256:sha(buf),experimental:true,evidence:{personBox:box,targetPixels:target,clippedPixels:clipped}});
   }
  }
 }
 m.images=[...m.sources,...m.pairs].map(({id,path,sha256})=>({id,path,sha256}));
 const output=path.resolve('data/cache/bench/w5-manifest.json');
 await fs.writeFile(output,JSON.stringify(m,null,2)+'\n');
 console.log(`W5 manifest ${output}: ${m.pairs.length-original.pairs.length} new pairs; original manifest untouched`);
}
