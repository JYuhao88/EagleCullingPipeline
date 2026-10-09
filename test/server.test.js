import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisServer } from "../src/server.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

test("8000-result controls return small opt-in summaries while keeping the full persisted plan", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-control-payload-"));
  const taskStorePath = path.join(root,"tasks.json");
  const marker = "synthetic-analysis-result".repeat(48);
  await writeFile(taskStorePath,JSON.stringify({tasks:[{
    taskId:"large",status:"paused",libraryPath:"synthetic-library",items:Array.from({length:8000},(_,index)=>({id:String(index),status:"succeeded",result:{marker}})),
  }]}));
  const service=createAnalysisServer({port:0,taskStorePath});
  await service.listen();t.after(()=>service.server.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const measurements=[];
  for (const action of ["configure","pause","complete","fail","cancel"]) {
    const response=await fetch(`${base}/tasks/large/${action}?includeItems=false`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(action==="configure" ? {concurrency:128,delayMs:0} : {}),
    });
    assert.equal(response.status,200);
    const text=await response.text();const summary=JSON.parse(text);
    assert.equal(summary.taskId,"large");
    assert.equal(summary.items,undefined);
    assert.equal(summary.summary.total,8000);
    assert.ok(Buffer.byteLength(text)<2048);
    measurements.push(`${action}:${Buffer.byteLength(text)}B`);
  }
  const fullText=await (await fetch(`${base}/tasks/large`)).text();
  assert.ok(Buffer.byteLength(fullText)>8*1024*1024);
  const full=JSON.parse(fullText);
  assert.equal(full.items.length,8000);
  assert.equal(full.items[7999].result.marker,marker);
  assert.equal(full.config.concurrency,128);
  assert.equal(full.status,"cancelled");
  const legacy=await (await fetch(`${base}/tasks/large/pause`,{method:"POST"})).json();
  assert.equal(legacy.items.length,8000,"no query retains the previous API response contract");
  t.diagnostic(`Full ${Buffer.byteLength(fullText)}B; summary ${measurements.join(", ")}`);
});

test("one analysis batch uses bounded parallel decoders and preserves input order",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-parallel-batch-"));
  const filePath=path.join(root,"preview.png");
  await sharp({create:{width:128,height:96,channels:3,background:"#abcdef"}}).png().toFile(filePath);
  const service=createAnalysisServer({port:0,nativeImageThreads:1,imageResourceOptions:{concurrency:2,freeMemory:()=>4*1024**3,reserveBytes:0}});
  await service.listen();t.after(()=>service.server.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const items=Array.from({length:24},(_,index)=>({id:`photo-${23-index}`,filePath,thumbnailPath:filePath}));
  const response=await fetch(base+"/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items})});
  assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.items.map(item=>item.id),items.map(item=>item.id));
  const diagnostics=await (await fetch(base+"/diagnostics")).json();
  assert.equal(diagnostics.image.peak,2,"a single HTTP batch must actually use the gate's parallel capacity");
  assert.equal(diagnostics.image.active,0);assert.equal(diagnostics.image.pending,0);
});

test("local analysis service exposes health and analyzes bounded batches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-server-"));
  const dir = path.join(root, "one.info");
  await mkdir(dir);
  const filePath = path.join(dir, "one.png");
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toFile(filePath);
  const service = createAnalysisServer({ port: 0 });
  await service.listen();
  t.after(() => service.server.close());
  const port = service.server.address().port;
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true, service: "eagle-culling" });
  const response = await fetch(`http://127.0.0.1:${port}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: "one", name: "one", filePath }] }) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.groups.length, 1);
  const diagnostics = await (await fetch(`http://127.0.0.1:${port}/diagnostics`)).json();
  assert.ok(diagnostics.image.concurrency >= 1);
  assert.ok(diagnostics.image.nativeThreads >= 1);
  assert.equal(typeof diagnostics.image.freeMemoryBytes,"number");
  const clustered = await fetch(`http://127.0.0.1:${port}/cluster`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [payload.items[0], { ...payload.items[0], id: "duplicate" }] }) });
  assert.equal(clustered.status, 200);
  assert.equal((await clustered.json()).groups[0].size, 2);
});

test("local service creates a labeled custom thumbnail without changing the source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-badge-"));
  const sourcePath = path.join(root, "source.png");
  const outputPath = path.join(root, "badge.png");
  await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 60, g: 80, b: 100 } } }).png().toFile(sourcePath);
  const service = createAnalysisServer({ port: 0 });
  await service.listen();
  t.after(() => service.server.close());
  const port = service.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/badge-thumbnail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath, outputPath, tags: ["AI精选", "AI过曝"] }) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.skipped, false);
  const outputMetadata = await sharp(outputPath).metadata();
  const sourceMetadata = await sharp(sourcePath).metadata();
  assert.equal(outputMetadata.format, "png");
  assert.equal(sourceMetadata.width, 120);
  assert.equal(sourceMetadata.height, 80);
});

test("clustering respects exact threshold zero and rejects invalid thresholds before analysis", async(t)=>{
  const service=createAnalysisServer({port:0});
  await service.listen();t.after(()=>service.server.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const send=(route,body)=>fetch(base+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const items=[{id:"a",phash:"0".repeat(63)},{id:"b",phash:"1"+"0".repeat(62)}];
  assert.equal((await (await send("/cluster",{items,phashThreshold:0})).json()).groups.length,2);
  assert.equal((await (await send("/cluster",{items,phashThreshold:1})).json()).groups.length,1);
  for(const phashThreshold of [-1,65,"bad",1.5]) {
    assert.equal((await send("/cluster",{items,phashThreshold})).status,400);
    assert.equal((await send("/analyze",{items:[{id:"missing",filePath:"not-opened"}],phashThreshold})).status,400);
  }
});

test("task API persists queue lifecycle and item progress", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-tasks-"));
  const service = createAnalysisServer({ port: 0, taskStorePath: path.join(root, "tasks.json") });
  await service.listen();
  t.after(() => service.server.close());
  const port = service.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${base}/version`)).json();
  assert.equal(version.version, "0.4.0");
  const createdResponse = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "badge-thumbnails-selection", items: [{ id: "one" }, { id: "two" }] }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const progressed = await fetch(`${base}/tasks/${created.taskId}/progress`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: "one", status: "succeeded", attempts: 1, outputPath: "one.png" }) });
  assert.equal((await progressed.json()).summary.succeeded, 1);
  const paused = await (await fetch(`${base}/tasks/${created.taskId}/pause`, { method: "POST" })).json();
  assert.equal(paused.status, "paused");
  const configured = await (await fetch(`${base}/tasks/${created.taskId}/configure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concurrency: 32, delayMs: 0 }) })).json();
  assert.equal(configured.config.concurrency, 32);
  assert.equal(configured.config.delayMs, 0);
  const invalid = await fetch(`${base}/tasks/${created.taskId}/configure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concurrency: -1, delayMs: 0 }) });
  assert.equal(invalid.status, 400);
  const resumed = await (await fetch(`${base}/tasks/${created.taskId}/resume`, { method: "POST" })).json();
  assert.equal(resumed.status, "running");
  assert.equal(resumed.config.concurrency, 32);
  const retried = await (await fetch(`${base}/tasks/${created.taskId}/retry`, { method: "POST" })).json();
  assert.equal(retried.items.find((item) => item.id === "one").status, "succeeded");
  const checkpoint = await (await fetch(`${base}/tasks/${created.taskId}/checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ itemId: "two", status: "succeeded" }] }) })).json();
  assert.equal(checkpoint.items, undefined);
  assert.equal(checkpoint.summary.succeeded, 2);
  assert.ok(JSON.stringify(checkpoint).length < 2048);
  const full = await (await fetch(`${base}/tasks/${created.taskId}`)).json();
  assert.equal(full.items.length, 2);
});

test("task journal errors are reported without crashing the HTTP server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-corrupt-store-"));
  const storePath = path.join(root, "tasks.json");
  await writeFile(`${storePath}.journal`, "invalid complete journal record\n");
  const service = createAnalysisServer({ port: 0, taskStorePath: storePath });
  await service.listen();
  t.after(() => service.server.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const response = await fetch(`${base}/tasks`);
  assert.equal(response.status, 500);
  assert.ok((await response.json()).error);
  assert.equal((await fetch(`${base}/health`)).status, 503);
  assert.equal((await fetch(`${base}/version`)).status, 200);
});

test("execution HTTP API rejects a second window and checkpoints without its owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-owner-http-"));
  const service = createAnalysisServer({port:0,taskStorePath:path.join(root,"tasks.json")});
  await service.listen(); t.after(()=>service.server.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = (url, body, owner) => fetch(base+url,{method:"POST",headers:{"content-type":"application/json",...(owner?{"x-task-owner":owner}:{})},body:JSON.stringify(body||{})});
  const task = await (await post("/tasks",{taskType:"review-units",libraryPath:"library",items:[{id:"photo"}]})).json();
  const prefix = `/tasks/${task.taskId}`;
  assert.equal((await post(prefix+"/claim",{ownerId:"a",libraryPath:"library"})).status,200);
  assert.equal((await post(prefix+"/claim",{ownerId:"b",libraryPath:"library"})).status,409);
  assert.equal((await post(prefix+"/checkpoint",{items:[{itemId:"photo",status:"succeeded"}]})).status,409);
  assert.equal((await post(prefix+"/checkpoint",{items:[{itemId:"photo",status:"succeeded"}]},"a")).status,200);
  await post(prefix+"/cancel");
  assert.equal((await (await post(prefix+"/heartbeat",{ownerId:"a",libraryPath:"library"})).json()).status,"cancelled");
  assert.equal((await (await post(prefix+"/complete",{},"a")).json()).status,"cancelled");
  await post(prefix+"/release",{ownerId:"a",libraryPath:"library"});
  assert.equal((await post(prefix+"/checkpoint",{items:[{itemId:"photo",status:"succeeded"}]},"a")).status,409);
  assert.equal((await post(prefix+"/checkpoint",{items:[{itemId:"photo",status:"succeeded"}]})).status,409);
});

test("disconnecting an analysis client releases its memory-pressure queue without decoding", async (t) => {
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-memory-abort-"));
  const service=createAnalysisServer({port:0,taskStorePath:path.join(root,"tasks.json"),imageResourceOptions:{concurrency:1,freeMemory:()=>0,reserveBytes:0,jobBudgetBytes:1}});
  await service.listen();t.after(()=>service.server.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const controller=new AbortController();
  const waiting=fetch(base+"/analyze",{method:"POST",headers:{"content-type":"application/json"},signal:controller.signal,body:JSON.stringify({items:[{id:"one",filePath:"not-decoded.jpg"}]})});
  const diagnostics=async()=>(await(await fetch(base+"/diagnostics")).json()).image;
  for(let index=0;index<100 && !(await diagnostics()).pending;index++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await diagnostics()).pending,1);
  controller.abort();await assert.rejects(waiting,/abort/i);
  for(let index=0;index<100 && (await diagnostics()).pending;index++)await new Promise(resolve=>setTimeout(resolve,5));
  const final=await diagnostics();
  assert.equal(final.pending,0);assert.equal(final.peak,0);
  assert.equal((await fetch(base+"/health")).status,200);
});
