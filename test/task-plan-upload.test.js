import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { createAnalysisServer } from "../src/server.js";
import { planChunks, uploadTaskPlan } from "../src/plugin/task-plan-upload.js";
import { submitDurablePlan } from "../src/plugin/plan-drafts.js";

test("plan chunks bound UTF-8 bytes without a photo count cap", () => {
  const items = Array.from({ length: 8000 }, (_, id) => ({ id: String(id), result: { name: "中文".repeat(100) } }));
  const chunks = planChunks(items);
  assert.ok(Buffer.byteLength(JSON.stringify(items)) > 2 * 1024 * 1024);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flatMap(chunk => chunk.items), items);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 512 * 1024);
  assert.throws(() => planChunks([{ id: "huge", result: "x".repeat(600000) }]), /单项/);
});

test("staged 8000-item HTTP plan stays paused after seal and cannot be picked up before atomic activation",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-staged-plan-"));
  const taskStorePath=path.join(root,"tasks.json");
  const service=createAnalysisServer({port:0,taskStorePath});await service.listen();
  t.after(()=>service.server.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const request=async(url,options)=>{
    const response=await fetch(base+url,options);const value=await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error),{statusCode:response.status});
    if (url.endsWith("/seal")) {
      assert.equal(value.status,"paused");assert.equal(value.activationPending,true);
      const intruder=await fetch(base+`/tasks/${value.taskId}/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerId:"automatic-other-window",libraryPath:"library"})});
      assert.equal(intruder.status,409,"another automatic executor cannot claim the sealed plan");
    }
    return value;
  };
  const items=Array.from({length:8000},(_,id)=>({id:String(id),result:{reason:"中文".repeat(100)}}));
  const task=await uploadTaskPlan(request,{taskType:"review-units",libraryPath:"library",activationPending:true,items});
  assert.equal(task.items.length,8000);assert.equal(task.status,"paused");
  const restarted=new TaskStore(taskStorePath);const restored=await restarted.get(task.taskId);
  assert.equal(restored.activationPending,true);assert.equal(restored.status,"paused");
  await assert.rejects(restarted.command(task.taskId,"resume"),/显式激活/);
  const claims=await Promise.allSettled(["review-window","other-window"].map(ownerId=>restarted.execution(task.taskId,"claim",{ownerId,libraryPath:"library",activate:true})));
  assert.equal(claims.filter(result=>result.status==="fulfilled").length,1);
  const activated=claims.find(result=>result.status==="fulfilled").value;
  assert.equal(activated.status,"running");assert.equal(activated.activationPending,false);
  assert.ok(activated.execution.ownerId);
});

test("small staged plans and incomplete uploads cannot be activated implicitly",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-staged-small-"));
  const store=new TaskStore(path.join(root,"tasks.json"));
  const task=await store.create({libraryPath:"library",activationPending:true,status:"pending",items:[{id:"one"}]});
  assert.equal(task.status,"paused");assert.equal(task.requiresExecution,true);
  for (const command of ["resume","start","retry"]) await assert.rejects(store.command(task.taskId,command),/显式激活/);
  await assert.rejects(store.execution(task.taskId,"claim",{ownerId:"old-window",libraryPath:"library"}),/显式激活/);
  const incomplete=await store.create({libraryPath:"library",activationPending:true,upload:{expectedTotal:2},items:[]});
  await assert.rejects(store.execution(incomplete.taskId,"claim",{ownerId:"window",libraryPath:"library",activate:true}),/可执行/);
  await store.command(task.taskId,"cancel");
  await assert.rejects(store.execution(task.taskId,"claim",{ownerId:"window",libraryPath:"library",activate:true}),/可执行/);
});

test("partial plan survives restart, verifies replay and cannot run before sealing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-upload-store-"));
  const file = path.join(root, "tasks.json");
  let store = new TaskStore(file);
  const draft = await store.create({ taskType: "analyze-selection", libraryPath: "library", requiresExecution: true, upload: { expectedTotal: 3 } });
  const chunk = { offset: 0, items: [{ id: "a", result: { raw: "中文" } }, { id: "b" }] };
  await store.appendPlan(draft.taskId, chunk);
  store = new TaskStore(file);
  assert.equal((await store.get(draft.taskId)).items.length, 2);
  await store.appendPlan(draft.taskId, chunk);
  assert.equal((await store.get(draft.taskId)).items.length, 2);
  await assert.rejects(store.appendPlan(draft.taskId, { ...chunk, items: [{ id: "changed" }] }), /differs/);
  await assert.rejects(store.command(draft.taskId, "resume"), /upload/);
  await assert.rejects(store.execution(draft.taskId, "claim", { ownerId: "one", libraryPath: "library" }), /可执行/);
  await assert.rejects(store.sealPlan(draft.taskId), /incomplete/);
  await assert.rejects(store.appendPlan(draft.taskId, { offset: 2, items: [{ id: "a" }] }), /Duplicate/);
  await store.appendPlan(draft.taskId, { offset: 2, items: [{ id: "c" }] });
  const sealed = await store.sealPlan(draft.taskId);
  assert.equal(sealed.status, "pending"); assert.equal(sealed.summary.total, 3);
  await store.sealPlan(draft.taskId);
  assert.equal((await store.appendPlan(draft.taskId, chunk)).items.length, 3);
  await assert.rejects(store.appendPlan(draft.taskId, {offset:3,items:[{id:"d"}]}), /not accepting/);
});

test("8000 rich plans upload through the real HTTP body limit and lost chunk ACK does not duplicate", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-upload-http-"));
  const service = createAnalysisServer({ port: 0, taskStorePath: path.join(root, "tasks.json") });
  await service.listen(); t.after(() => service.server.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  let lostAck = false, planPosts = 0;
  const request = async (url, options) => {
    const response = await fetch(base + url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (url.endsWith("/plan")) {
      planPosts++;
      if (!lostAck) { lostAck = true; throw new Error("simulated response loss after persisted append"); }
    }
    return result;
  };
  const items = Array.from({ length: 8000 }, (_, id) => ({ id: String(id), result: { source: "照片".repeat(70), members: [String(id)] } }));
  const progress = [];
  const task = await uploadTaskPlan(request, { taskType: "analyze-selection", libraryPath: "library", requiresExecution: true, items }, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(task.status, "pending"); assert.equal(task.upload.sealed, true);
  assert.equal(task.items.length, 8000); assert.equal(task.items[7999].id, "7999");
  assert.equal(new Set(task.items.map(item => item.id)).size, 8000);
  assert.deepEqual(progress.at(-1), [8000, 8000]);
  assert.equal(planPosts, planChunks(items).length + 1);
});

test("interrupted client resumes the same persisted draft rather than creating another task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-upload-resume-"));
  const file = path.join(root, "tasks.json");
  let store = new TaskStore(file), draftId, broken = true;
  const items = Array.from({ length: 2000 }, (_, id) => ({ id: String(id), result: "中文".repeat(100) }));
  const request = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (url === "/tasks") { const draft = await store.create(body); draftId = draft.taskId; return draft; }
    if (url.endsWith("/plan")) {
      if (body.offset > 0 && broken) throw new Error("connection interrupted");
      return store.appendPlan(draftId, body);
    }
    if (url.endsWith("/seal")) return store.sealPlan(draftId);
    return store.get(draftId);
  };
  const input = { taskType: "analyze-selection", libraryPath: "library", items };
  await assert.rejects(uploadTaskPlan(request, input), /已保留断点/);
  const partial = await store.get(draftId);
  assert.ok(partial.items.length > 0 && partial.items.length < items.length);
  store = new TaskStore(file); broken = false;
  await assert.rejects(uploadTaskPlan(request, { ...input, libraryPath: "other" }, { resumeTaskId: draftId }), /不一致/);
  const result = await uploadTaskPlan(request, input, { resumeTaskId: draftId });
  assert.equal(result.items.length, items.length); assert.equal(result.status, "pending");
  assert.equal((await store.list()).length, 1);
});

test("durable client saves before network and recovers lost creation and seal responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-client-draft-"));
  const store = new TaskStore(path.join(root, "tasks.json"));
  const saved = new Map();
  const draftStore = {put:async draft=>saved.set(draft.taskId,structuredClone(draft)),get:async id=>structuredClone(saved.get(id)),remove:async id=>saved.delete(id)};
  let lose = "create", creates = 0;
  const request = async (url, options) => {
    const input = options?.body ? JSON.parse(options.body) : null;
    if (url === "/tasks") {
      assert.ok(saved.has(input.taskId), "full client plan must commit before creating server task");
      creates++; const task = await store.create(input);
      if (lose === "create") throw new Error("lost creation response");
      return task;
    }
    const id = url.split("/")[2];
    if (url.endsWith("/plan")) return store.appendPlan(id, input);
    if (url.endsWith("/seal")) {
      const task = await store.sealPlan(id);
      if (lose === "seal") throw new Error("lost seal response");
      return task;
    }
    const task = await store.get(id);
    if (!task) throw Object.assign(new Error("missing"),{statusCode:404});
    return task;
  };
  const input = {taskType:"analyze-selection",libraryPath:"library",items:Array.from({length:2000},(_,id)=>({id:String(id),result:"中文".repeat(100)}))};
  await assert.rejects(submitDurablePlan(request,input,{store:draftStore}), /lost creation/);
  const id = [...saved.keys()][0]; assert.equal(saved.get(id).input.items.length,2000);
  lose = "seal";
  await assert.rejects(submitDurablePlan(request,{libraryPath:"library"},{store:draftStore,resumeTaskId:id}), /lost seal/);
  assert.equal((await store.get(id)).status,"pending"); assert.ok(saved.has(id));
  lose = null;
  const recovered = await submitDurablePlan(request,{libraryPath:"library"},{store:draftStore,resumeTaskId:id});
  assert.equal(recovered.items.length,2000); assert.equal(creates,1); assert.equal(saved.size,0);
  let requested = false;
  await assert.rejects(submitDurablePlan(async()=>{requested=true;},input,{store:{put:async()=>{throw new Error("disk quota");}}}),/disk quota/);
  assert.equal(requested,false);
});
