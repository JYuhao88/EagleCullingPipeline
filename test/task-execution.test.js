import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { claimTaskExecution } from "../src/plugin/task-execution.js";
import { runBoundedQueue } from "../src/plugin/task-queue.js";

test("only one executor per task/library; ownership persists across service restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-execution-"));
  const storePath = path.join(root, "tasks.json");
  const store = new TaskStore(storePath);
  const task = await store.create({ taskType: "restore-thumbnails", libraryPath: "library", items: [{id:"one"}] });
  const second = await store.create({ taskType: "review-units", libraryPath: "library", items: [{id:"two"}] });
  const ownership = {ownerId:"window-a",libraryPath:"library"};
  await store.execution(task.taskId, "claim", ownership);
  await assert.rejects(store.execution(task.taskId, "claim", {...ownership,ownerId:"window-b"}), /另一个窗口/);
  await assert.rejects(store.execution(second.taskId, "claim", {...ownership,ownerId:"window-b"}), /其他运行窗口/);
  await assert.rejects(store.updateItems(task.taskId, [{itemId:"one",status:"succeeded"}]), /执行权/);
  await assert.rejects(store.command(task.taskId, "complete", "window-b"), /执行权/);
  await store.updateItems(task.taskId, [{itemId:"one",status:"succeeded"}], "window-a");
  await store.command(task.taskId, "pause");
  assert.equal((await store.command(task.taskId, "complete", "window-a")).status, "paused");
  await assert.rejects(store.command(task.taskId, "resume"), /在途请求/);
  const restarted = new TaskStore(storePath);
  assert.equal((await restarted.get(task.taskId)).execution.ownerId, "window-a");
  await restarted.execution(task.taskId, "release", ownership);
  await restarted.command(task.taskId, "resume");
  await restarted.execution(task.taskId, "claim", {...ownership,ownerId:"window-b"});
  await assert.rejects(restarted.updateItems(task.taskId, [{itemId:"one",status:"succeeded"}], "window-a"), /执行权/);
});

test("stale ownership requires explicit confirmation and never silently expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-stale-execution-"));
  const store = new TaskStore(path.join(root, "tasks.json"));
  const task = await store.create({taskType:"test",libraryPath:"library",items:[]});
  const ownership = {ownerId:"window-a",libraryPath:"library"};
  await store.execution(task.taskId, "claim", ownership);
  await assert.rejects(store.execution(task.taskId, "recover", {...ownership,confirmed:true}), /30 秒/);
  await store.update(task.taskId, {execution:{ownerId:"window-a",heartbeatAt:new Date(Date.now()-60000).toISOString()}});
  await assert.rejects(store.execution(task.taskId, "claim", {...ownership,ownerId:"window-b"}), /不会自动抢占/);
  await assert.rejects(store.execution(task.taskId, "recover", ownership), /确认/);
  const recovered = await store.execution(task.taskId, "recover", {...ownership,confirmed:true});
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.execution, null);
  await assert.rejects(store.execution(task.taskId, "heartbeat", ownership), /执行权/);
});

test("remote pause/cancel interrupts pending writes without marking photos failed", async (t) => {
  for (const status of ["paused", "cancelled"]) {
    const controls = [];
    const execution = await claimTaskExecution({task:{taskId:"task",libraryPath:"library"}, ownerId:"window", intervalMs:60000,
      request: async (url) => ({status:url.endsWith("heartbeat") ? status : "running"}), onControl:(next)=>controls.push(next)});
    t.after(()=>execution.close());
    await execution.heartbeat();
    assert.deepEqual(controls, [status]);
    const item = {id:"one",status:"pending"};
    const results = await runBoundedQueue({items:[item],process:async()=>execution.guard(),onProgress:()=>assert.fail("must not mark interrupted items failed")});
    assert.equal(results.failed, 0);
    assert.equal(item.status, "pending");
    await execution.close();
  }
});

test("heartbeat loss or stale service acknowledgement stops new writes", async () => {
  let clock = 0;
  const execution = await claimTaskExecution({task:{taskId:"task",libraryPath:"library"},ownerId:"window",intervalMs:60000,clock:()=>clock,
    request:async(url)=>{if(url.endsWith("heartbeat"))throw new Error("offline");return {status:"running"};}});
  execution.guard();
  clock = 10001;
  assert.throws(()=>execution.guard(), (error)=>error.fatal && /失联/.test(error.message));
  clock = 0;
  await execution.heartbeat();
  assert.throws(()=>execution.guard(), (error)=>error.fatal && /offline/.test(error.message));
  await execution.close();
});
