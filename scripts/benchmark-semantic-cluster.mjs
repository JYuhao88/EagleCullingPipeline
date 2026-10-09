import { SemanticClusterQueue } from "../src/semantic-cluster.js";
import { EMBEDDING_VERSION } from "../src/semantic-worker-client.js";

let seed=12345;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296-0.5;};
const items=Array.from({length:8000},(_,id)=>{
  const values=Array.from({length:384},random),norm=Math.hypot(...values);
  return {id:String(id),embedding:values.map(value=>value/norm),embeddingVersion:EMBEDDING_VERSION,semantic:{available:true}};
});
const queue=new SemanticClusterQueue();
let ticks=0,maxTickGapMs=0,lastTick=performance.now();
const timer=setInterval(()=>{const now=performance.now();maxTickGapMs=Math.max(maxTickGapMs,now-lastTick);lastTick=now;ticks++;},10);
const started=performance.now();
try {
  const groups=await queue.run(items,0.94);
  console.log(JSON.stringify({sampleCount:items.length,dimensions:384,groups:groups.length,elapsedMs:Math.round(performance.now()-started),mainThreadTicks:ticks,maxTickGapMs:Math.round(maxTickGapMs),diagnostics:queue.diagnostics(),caveats:["Synthetic vectors, no inference or Eagle calls.","Does not validate similarity accuracy, full-library throughput or peak RSS/VRAM."]},null,2));
} finally {clearInterval(timer);queue.close();}
