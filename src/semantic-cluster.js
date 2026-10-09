import { Worker } from "node:worker_threads";
import { ResourceGate } from "./resource-gate.js";
import { EMBEDDING_VERSION } from "./semantic-worker-client.js";

export class SemanticClusterQueue {
  constructor() { this.gate = new ResourceGate({concurrency:1});this.workers=new Set(); }
  run(items, threshold = 0.94, {signal} = {}) {
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) return Promise.reject(new Error("Cosine threshold must be from -1 to 1"));
    const compatible = items.filter(item=>item.embeddingVersion === EMBEDDING_VERSION && item.semantic?.available === true && Array.isArray(item.embedding) && item.embedding.length === 384 && item.embedding.every(Number.isFinite) && Math.abs(Math.hypot(...item.embedding)-1)<1e-5);
    // Don't clone image paths, metadata or duplicated paired results into the
    // clustering worker. It needs only IDs, coarse rank and current vectors.
    const input = compatible.map(({id,qualityScore,embedding})=>({id,qualityScore,embedding}));
    return this.gate.run(()=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL("./semantic-cluster-worker.js",import.meta.url),{workerData:{items:input,threshold}});
      this.workers.add(worker);
      let result, error;
      const stop = reason=>{error ||= reason;worker.terminate().catch(()=>{});};
      const abort = ()=>stop(signal.reason || new Error("Clustering cancelled"));
      signal?.addEventListener("abort",abort,{once:true});
      if (signal?.aborted) abort();
      const timer=setTimeout(()=>stop(new Error("Semantic clustering exceeded 60 seconds")),60000);
      worker.once("message",value=>{result=value;});
      worker.once("error",failure=>{error=failure;});
      worker.once("exit",code=>{
        clearTimeout(timer);signal?.removeEventListener("abort",abort);this.workers.delete(worker);
        if (error || code || !result) reject(error || new Error(`Clustering worker exited (${code})`));
        else resolve(result.map(group=>({...group,embeddingVersion:EMBEDDING_VERSION})));
      });
    }),{signal});
  }
  diagnostics() {return {...this.gate.diagnostics(),workerThreads:this.workers.size};}
  close() {this.gate.close();for(const worker of this.workers) worker.terminate().catch(()=>{});}
}
