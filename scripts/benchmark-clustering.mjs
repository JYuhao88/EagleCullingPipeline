// Synthetic in-memory pHash benchmark; no Eagle requests or library writes.
import { clusterByPhash } from "../src/image-analyzer.js";
let seed=123;
const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const diverse=Array.from({length:8000},(_,i)=>({id:String(i),phash:next().toString(2).padStart(32,"0")+next().toString(2).padStart(32,"0")}));
for (const [caseName,items] of [["diverse",diverse],["same-hash",diverse.map(item=>({...item,phash:"0".repeat(63)}))]]) {
  const started=performance.now();
  const groups=clusterByPhash(items);
  console.log(JSON.stringify({caseName,items:items.length,groups:groups.length,elapsedMs:Math.round(performance.now()-started)}));
}
