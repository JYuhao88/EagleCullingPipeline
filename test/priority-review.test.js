import assert from "node:assert/strict";
import test from "node:test";
import { runPriorityReview } from "../src/plugin/priority-review.js";

function fixture(overrides = {}) {
  const events = [];
  const options = {
    background:{taskId:"analysis",taskType:"analyze-selection"},
    pause:async()=>events.push("pause"),drain:async()=>events.push("drained"),
    getTask:async()=>({taskId:"analysis",status:"paused",execution:null}),
    runReview:async()=>events.push("review"),resume:async()=>events.push("resume"),
    ...overrides,
  };
  return {events,options};
}

test("manual review drains analysis before writing, then resumes its checkpoint",async()=>{
  const {events,options}=fixture();let release;
  options.drain=()=>new Promise(resolve=>{release=()=>{events.push("drained");resolve();};});
  const running=runPriorityReview(options);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,["pause"],"no review writes before all in-flight analysis drains");
  release();await running;
  assert.deepEqual(events,["pause","drained","review","resume"]);
});

test("review failure or unreleased owner never restarts or overlaps analysis",async()=>{
  const failing=fixture({runReview:async()=>{throw new Error("checkpoint failed");}});
  await assert.rejects(runPriorityReview(failing.options),/checkpoint failed/);
  assert.deepEqual(failing.events,["pause","drained"]);
  const owned=fixture({getTask:async()=>({status:"paused",execution:{ownerId:"other-window"}})});
  await assert.rejects(runPriorityReview(owned.options),/执行权/);
  assert.deepEqual(owned.events,["pause","drained"]);
});

test("library/user control changes prevent writes or automatic resume",async()=>{
  let allowed=true;
  const switched=fixture({stillAllowed:()=>allowed,drain:async()=>{allowed=false;}});
  await assert.rejects(runPriorityReview(switched.options),/变化/);
  assert.deepEqual(switched.events,["pause"]);
  allowed=true;
  const manualPause=fixture({stillAllowed:()=>allowed,runReview:async()=>{allowed=false;}});
  await runPriorityReview(manualPause.options);
  assert.deepEqual(manualPause.events,["pause","drained"]);
});

test("switching libraries during the asynchronous ownership read prevents review writes",async()=>{
  let allowed=true;
  const {events,options}=fixture({stillAllowed:()=>allowed,getTask:async()=>{
    allowed=false;return {status:"paused",execution:null};
  }});
  await assert.rejects(runPriorityReview(options),/变化/);
  assert.deepEqual(events,["pause","drained"]);
});

test("finished analysis is not restarted, maintenance is not preempted, standalone review works",async()=>{
  const finished=fixture({getTask:async()=>({status:"succeeded",execution:null})});
  await runPriorityReview(finished.options);assert.deepEqual(finished.events,["pause","drained","review"]);
  const maintenance=fixture({background:{taskType:"restore-thumbnails"}});
  await assert.rejects(runPriorityReview(maintenance.options),/缩略图/);assert.deepEqual(maintenance.events,[]);
  const standalone=fixture({background:null});
  await runPriorityReview(standalone.options);assert.deepEqual(standalone.events,["review"]);
});
