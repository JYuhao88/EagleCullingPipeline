import assert from "node:assert/strict";
import test from "node:test";
import { SemanticClusterQueue } from "../src/semantic-cluster.js";
import { EMBEDDING_VERSION } from "../src/semantic-worker-client.js";

test("semantic clustering runs off-thread, excludes invalid versions and cancels without leaking workers", async t=>{
  const queue=new SemanticClusterQueue();t.after(()=>queue.close());
  const embedding=Array(384).fill(0);embedding[0]=1;
  const item={id:"one",embedding,embeddingVersion:EMBEDDING_VERSION,semantic:{available:true}};
  const groups=await queue.run([item,{...item,id:"two"},{...item,id:"old",embeddingVersion:"old"}]);
  assert.equal(groups.length,1);assert.equal(groups[0].size,2);
  assert.equal(queue.diagnostics().workerThreads,0);
  const controller=new AbortController();
  const pending=queue.run(Array.from({length:8000},(_,id)=>({...item,id:String(id)})),0.94,{signal:controller.signal});
  controller.abort(new Error("paused"));await assert.rejects(pending,/paused/);
  assert.equal(queue.diagnostics().workerThreads,0);assert.equal(queue.diagnostics().pending,0);
  assert.equal((await queue.run([item])).length,1);
});
