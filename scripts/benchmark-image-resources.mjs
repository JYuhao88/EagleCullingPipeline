// Synthetic preview workload only; never opens the user's photos or real task store.
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createAnalysisServer } from "../src/server.js";

const childPolicy=process.argv[2];
if(childPolicy && !["unbounded","balanced"].includes(childPolicy))throw new Error("Unknown benchmark policy");
const root = process.argv[3] || await mkdtemp(path.join(os.tmpdir(), "eagle-image-resources-"));
const width=640, height=480;
const pixels=Buffer.alloc(width*height*3);
for(let index=0;index<pixels.length;index++)pixels[index]=(index*31+Math.floor(index/640)*17)%256;
const proxy=path.join(root,"proxy.jpg");
await sharp(pixels,{raw:{width,height,channels:3}}).jpeg().toFile(proxy);
const results=[];
for(const policy of childPolicy ? [childPolicy] : ["unbounded","balanced"]){
  if(!childPolicy){
    const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),policy,root],{windowsHide:true});
    results.push(JSON.parse(stdout).results[0]);
    continue;
  }
  const service=createAnalysisServer({port:0,taskStorePath:path.join(root,policy+"-tasks.json"),
    ...(policy==="unbounded"?{imageResourceOptions:{concurrency:128,jobBudgetBytes:1,reserveBytes:0},nativeImageThreads:os.availableParallelism()}:{})});
  await service.listen();
  const base=`http://127.0.0.1:${service.server.address().port}`;
  let peakRss=process.memoryUsage().rss;
  const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},20);
  const cpuStart=process.cpuUsage();
  const startedAt=performance.now();
  try{
    await Promise.all(Array.from({length:128},async(_,index)=>{
      const response=await fetch(base+"/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[{id:String(index),filePath:path.join(root,"not-opened-original.jpg"),analysisPath:proxy,width:6000,height:4000}]})});
      if(!response.ok)throw new Error(await response.text());
      await response.json();
    }));
    const elapsedMs=Math.round(performance.now()-startedAt);
    const cpu=process.cpuUsage(cpuStart);
    const diagnostics=await(await fetch(base+"/diagnostics")).json();
    results.push({policy,elapsedMs,cpuMs:Math.round((cpu.user+cpu.system)/1000),sampledPeakRssMiB:Math.round(peakRss/1024**2),image:diagnostics.image});
  }finally{clearInterval(sample);await new Promise(resolve=>service.server.close(resolve));}
}
console.log(JSON.stringify({fixture:root,workload:"128 simultaneous synthetic preview requests; faces disabled; isolated process per policy",results},null,2));
