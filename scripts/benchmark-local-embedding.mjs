// Offline comparison of existing CPU/DirectML providers, no installs/Eagle writes.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cosineSimilarity } from "../src/embedding.js";

const reportPath=process.argv[2];
if(!reportPath) throw new Error("Usage: node scripts/benchmark-local-embedding.mjs <real-analysis-report.json>");
const source=JSON.parse(await readFile(reportPath,"utf8"));
const items=source.results.filter(item=>item.thumbnailPath).map(item=>({id:item.id,filePath:item.thumbnailPath}));
if(!items.length) throw new Error("No preview sample paths");
const root=await mkdtemp(path.join(os.tmpdir(),"eagle-embedding-benchmark-"));
const results=[];
for(const provider of ["cpu","dml"]) {
  const started=performance.now();
  const lines=await new Promise((resolve,reject)=>{
    const child=spawn(".venv/Scripts/python.exe",["python_worker/embedding_worker.py","--provider",provider,"--profile-dir",root],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONUTF8:"1",OMP_NUM_THREADS:"2"}});
    let output="",stderr="";
    const timeout=setTimeout(()=>{child.kill();reject(new Error(`${provider} benchmark exceeded 90 seconds`));},90000);
    child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
    child.once("error",error=>{clearTimeout(timeout);reject(error);});
    child.once("close",code=>{clearTimeout(timeout);if(code) reject(new Error(`${provider} failed: ${output} ${stderr}`));else resolve(output.trim().split("\n").map(line=>JSON.parse(line)));});
    child.stdin.on("error",()=>{});child.stdin.end(items.map(item=>JSON.stringify(item)).join("\n")+"\n");
  });
  const records=lines.filter(item=>item.id);
  const profile=JSON.parse(await readFile(lines.find(item=>item.type==="profile").path,"utf8"));
  const executedNodes={};
  for(const event of profile) if(event.args?.provider) executedNodes[event.args.provider]=(executedNodes[event.args.provider]||0)+1;
  results.push({provider,wallMs:Math.round(performance.now()-started),ready:lines.find(item=>item.type==="ready"),
    count:records.length,failed:records.filter(item=>!item.available).length,
    medianMs:records.map(item=>item.elapsedMs).sort((a,b)=>a-b)[Math.floor(records.length/2)],executedNodes,records});
}
const cpuById=new Map(results[0].records.map(item=>[item.id,item]));
const agreement=results[1].records.filter(item=>item.embedding && cpuById.get(item.id)?.embedding).map(item=>cosineSimilarity(item.embedding,cpuById.get(item.id).embedding));
const report={createdAt:new Date().toISOString(),sampleCount:items.length,results,minimumCpuGpuCosine:Math.min(...agreement),
  caveats:["Sequential session; preview input only; profiling enabled for both providers.","Not an IQA model or ground-truth duplicate accuracy benchmark.","No full-library throughput, Python RSS or GPU memory peak claim."]};
const output=path.join(root,"benchmark.json");await writeFile(output,JSON.stringify(report,null,2),"utf8");
console.log(JSON.stringify({...report,results:results.map(({records,...result})=>result),output},null,2));
