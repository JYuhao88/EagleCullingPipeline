import assert from "node:assert/strict";
import test from "node:test";
import { ResourceGate } from "../src/resource-gate.js";

test("128 concurrent image jobs respect decoder capacity and recover after failures", async () => {
  const gate = new ResourceGate({concurrency:4,freeMemory:()=>100,reserveBytes:10,jobBudgetBytes:10});
  let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({length:128},(_,index)=>gate.run(async()=>{
    active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,1)); active--;
    if(index===17)throw new Error("bad image"); return index;
  })));
  assert.equal(peak,4);assert.equal(results.filter(result=>result.status==="rejected").length,1);
  assert.equal(gate.diagnostics().pending,0);
  assert.equal(await gate.run(()=>"next"),"next"); gate.close();
});
test("memory pressure waits without launching decoders and resumes when memory returns", async () => {
  let freeMemory=15;
  const gate = new ResourceGate({concurrency:4,freeMemory:()=>freeMemory,reserveBytes:10,jobBudgetBytes:10,pollMs:5});
  let calls=0;
  const result=gate.run(()=>{calls++;return "done";});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,0);assert.equal(gate.diagnostics().pending,1);
  freeMemory=60;
  assert.equal(await result,"done");assert.equal(calls,1);gate.close();
});
test("aborting a queued request and closing the service never launches abandoned work", async () => {
  const gate = new ResourceGate({concurrency:1,freeMemory:()=>0,reserveBytes:0,jobBudgetBytes:10});
  const controller=new AbortController();
  const aborted=gate.run(()=>assert.fail("abandoned work started"),{signal:controller.signal});
  controller.abort(new Error("client gone"));
  await assert.rejects(aborted,/client gone/);
  const closed=gate.run(()=>assert.fail("closed work started")); gate.close();
  await assert.rejects(closed,/closed/);
  await assert.rejects(gate.run(()=>null),/closed/);
  assert.throws(()=>new ResourceGate({concurrency:0}),/Invalid/);
});
