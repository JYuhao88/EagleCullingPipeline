import assert from "node:assert/strict";
import test from "node:test";
import {restoreNativeVerified} from "../src/native-restore.js";
import {runBoundedQueue} from "../src/plugin/task-queue.js";

function fixture() {
  const state={item:{id:"one",modificationTime:1,name:"photo",ext:"jpg",width:320,height:480,tags:["人工","AI候选"],star:4,folders:["original"],annotation:"备注"},library:"library",writes:0,hash:"a".repeat(64),guards:0};
  const input={itemId:"one",libraryPath:"library",expectedModifiedAt:1,beforeWrite:async()=>{state.guards++;},fingerprintOriginal:async()=>state.hash,api:{
    libraryInfo:async()=>({path:state.library}),
    get:async()=>({data:[structuredClone(state.item)]}),
    refreshThumbnail:async()=>{state.writes++;state.item.width=6000;state.item.height=4000;state.item.modificationTime++;},
  }};
  return {state,input};
}

test("REST native refresh verifies original/human invariants, allowing derived dimensions to change",async()=>{
  const {state,input}=fixture();
  const result=await restoreNativeVerified(input);
  assert.equal(state.writes,1);assert.equal(state.guards,3);
  assert.equal(result.originalSha256Unchanged,true);assert.equal(result.humanMetadataUnchanged,true);
  assert.equal(result.previewVerified,false,"dimensions alone do not prove absence of badges or native preview clarity");
  assert.deepEqual(result.derivedDimensions,{before:[320,480],after:[6000,4000]});
});

test("missing guard, changed library/item and edits during hashing prevent the first mutation",async()=>{
  for (const [mutation,rejection] of [
    [(state,input)=>{input.beforeWrite=null;},/执行权检查/],
    [state=>{state.library="different-library";},/资源库已切换/],
    [state=>{state.item.modificationTime=2;},null],
    [(state,input)=>{input.fingerprintOriginal=async()=>{state.item.tags.push("刚刚修改");state.item.modificationTime++;return state.hash;};},null],
  ]) {
    const {state,input}=fixture();mutation(state,input);
    if (rejection) await assert.rejects(restoreNativeVerified(input),rejection);
    else assert.equal((await restoreNativeVerified(input)).status,"skipped");
    assert.equal(state.writes,0);
  }
});

test("post-refresh invariant violations never cause automatic retries or rollback writes",async()=>{
  for (const change of [state=>{state.hash="b".repeat(64);},state=>{state.item.star=5;},state=>{state.library="new-library";}]) {
    const {state,input}=fixture();
    input.api.refreshThumbnail=async()=>{state.writes++;change(state);};
    await assert.rejects(runBoundedQueue({items:[{id:"one"}],concurrency:1,maxAttempts:3,process:()=>restoreNativeVerified(input)}),error=>error.fatal && error.refreshOutcome==="unknown");
    assert.equal(state.writes,1);
  }
});

test("uncertain refresh and late verification failure stop the queue without repeating Eagle writes",async()=>{
  const {state,input}=fixture();
  input.api.refreshThumbnail=async()=>{state.writes++;throw new Error("acknowledgement lost");};
  await assert.rejects(runBoundedQueue({items:[{id:"one"},{id:"two"}],concurrency:1,maxAttempts:3,process:()=>restoreNativeVerified(input)}),error=>error.fatal && error.refreshOutcome==="unknown");
  assert.equal(state.writes,1);
});
