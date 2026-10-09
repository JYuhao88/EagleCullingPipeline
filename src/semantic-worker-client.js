import { FaceWorkerPool } from "./face-worker-client.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, mkdir, stat, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const EMBEDDING_VERSION = "dinov2-small-cls-224-v1";
const digest = value => createHash("sha256").update(value).digest("hex");
async function fileDigest(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
function validVector(result) {
  return result?.available === true && result.embeddingVersion === EMBEDDING_VERSION &&
    Array.isArray(result.embedding) && result.embedding.length === 384 &&
    result.embedding.every(Number.isFinite) && Math.abs(Math.hypot(...result.embedding)-1)<1e-5;
}

// DirectML does not permit concurrent Run calls on one session. Reuse exactly
// one model process; API concurrency only queues jobs, not model copies.
export class SemanticWorkerPool {
  constructor({ provider = process.env.EAGLE_EMBEDDING_PROVIDER || (process.platform === "win32" ? "dml" : "cpu"), cacheRoot, ...options } = {}) {
    if (!["dml", "cpu"].includes(provider)) throw new Error("Semantic provider must be dml or cpu");
    this.provider = provider;
    this.cwd = options.cwd || process.cwd();
    this.cacheRoot = cacheRoot === false ? null : path.resolve(this.cwd, cacheRoot || "data/cache/semantic");
    this.cache = {hits:0, misses:0, writes:0, invalid:0, writeErrors:0, inferenceItems:0};
    this.pool = new FaceWorkerPool({...options, size:1, script:"python_worker/embedding_worker.py",args:["--provider",provider]});
  }
  async identity() {
    // Pin a pool to its loaded code/configuration. Updating these while a model
    // is resident requires a new pool, rather than silently mixing identities.
    const manifestPath = path.join(this.cwd,"python_worker/model-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
    const model = manifest.models.find(model=>model.name==="dinov2-small");
    const files = [manifestPath, path.resolve(this.cwd,model.path),
      path.join(this.cwd,"python_worker/dinov2-preprocessor.json"),
      path.join(this.cwd,"python_worker/embedding_worker.py")];
    const signatures = await Promise.all(files.map(async file=>{const info=await stat(file);return [file,info.size,info.mtimeMs,info.ctimeMs];}));
    const signature = JSON.stringify(signatures);
    if (this.identitySignature && signature !== this.identitySignature) throw new Error("Semantic model/configuration changed; restart the service before reusing results");
    this.identitySignature = signature;
    this.identityPromise ||= (async()=>{
      const hashes = await Promise.all(files.map(fileDigest));
      if (hashes[1] !== model.sha256) throw new Error("DINOv2 checksum mismatch; refusing cached results");
      return digest(JSON.stringify([EMBEDDING_VERSION,this.provider,...hashes]));
    })();
    return this.identityPromise;
  }
  async run(items, options = {}) {
    const checkAbort = () => options.signal?.throwIfAborted();
    checkAbort();
    if (!this.cacheRoot) return this.runUncached(items,options);
    let identity;
    try { identity = await this.identity(); }
    catch(error) { checkAbort(); return items.map(item=>({id:item.id,available:false,error:error.message})); }
    checkAbort();
    const prepared = [], misses = new Map();
    // Serial bounded file hashing avoids 128 concurrent streams and does not
    // decode originals. Identical previews in a batch share one inference.
    for (const item of items) {
      checkAbort();
      const filePath = item.analysisPath || item.thumbnailPath;
      try {
        if (!filePath) throw new Error("No bounded preview supplied");
        if ((await stat(filePath)).size > 64*1024*1024) throw new Error("Semantic preview exceeds cache input budget");
        const contentHash = await fileDigest(filePath);
        checkAbort();
        const key = digest(JSON.stringify([identity,contentHash]));
        const cachePath = path.join(this.cacheRoot,key+".json");
        let cached;
        try {
          cached = JSON.parse(await readFile(cachePath,"utf8"));
          if (cached.key !== key || !validVector(cached.result)) { this.cache.invalid++; cached=null; }
        } catch(error) { if (error.code !== "ENOENT") this.cache.invalid++; }
        const entry = {item,filePath,key,cachePath,contentHash,cached};
        prepared.push(entry);
        if (cached) this.cache.hits++;
        else { this.cache.misses++; if (!misses.has(key)) misses.set(key,entry); }
      } catch(error) { checkAbort(); prepared.push({item,error:error.message}); }
    }
    checkAbort();
    const jobs = [...misses.values()];
    this.cache.inferenceItems += jobs.length;
    const results = await this.runUncached(jobs.map(entry=>({...entry.item,id:entry.key,analysisPath:entry.filePath})),options);
    const byKey = new Map(results.map(result=>[result.id,result]));
    for (const entry of jobs) {
      checkAbort();
      const result = byKey.get(entry.key);
      if (!validVector(result)) continue;
      // A file replaced during inference must not poison the old content key.
      if (await fileDigest(entry.filePath) !== entry.contentHash) {
        byKey.set(entry.key,{available:false,error:"Semantic preview changed during inference"});
        continue;
      }
      const temporary = entry.cachePath+"."+randomUUID()+".tmp";
      try {
        await mkdir(this.cacheRoot,{recursive:true});
        await writeFile(temporary,JSON.stringify({key:entry.key,result}),{flag:"wx"});
        await rename(temporary,entry.cachePath);
        this.cache.writes++;
      } catch { this.cache.writeErrors++; }
      finally { await rm(temporary,{force:true}); }
    }
    checkAbort();
    return prepared.map(entry=>entry.error ? {id:entry.item.id,available:false,error:entry.error} :
      {...(entry.cached?.result || byKey.get(entry.key)),id:entry.item.id,cacheHit:Boolean(entry.cached)});
  }
  async runUncached(items, options) {
    // Avoid implicit full-resolution RAW/JPEG decode in the semantic model.
    const usable = items.filter(item => item.analysisPath || item.thumbnailPath);
    const results = await this.pool.run(usable.map(item=>({id:item.id,filePath:item.analysisPath || item.thumbnailPath})), options);
    const byId = new Map(results.map(result=>[result.id,result]));
    return items.map(item=>{
      const result = byId.get(item.id);
      if (!result) return {id:item.id,available:false,error:"No bounded preview supplied"};
      if (!result.available) return result;
      return validVector(result) ? result : {id:item.id,available:false,error:"Semantic worker returned an invalid or incompatible vector"};
    });
  }
  diagnostics() { return {...this.pool.diagnostics(),requestedProvider:this.provider,embeddingVersion:EMBEDDING_VERSION,cache:{...this.cache,enabled:Boolean(this.cacheRoot)}}; }
  close() { this.pool.close(); }
}
