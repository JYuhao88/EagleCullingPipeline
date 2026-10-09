import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskReport, taskExceptionsCsv } from "../src/plugin/task-report.js";

test("report uses full records, differentiates processed versus success and paired file counts",()=>{
  const task={taskId:"t",status:"running",libraryPath:"lib",items:[
    {id:"a",status:"succeeded",result:{analysisPlan:{sourceId:"jpg",members:[{id:"jpg"},{id:"raw"}]}}},
    {id:"b",status:"skipped",error:"已修改"},{id:"c",status:"failed",error:"读取失败"},{id:"d",status:"pending"}],summary:{total:9999}};
  const report=buildTaskReport(task,"snapshot");
  assert.equal(report.counts.total,4);assert.equal(report.counts.affectedFiles,5);
  assert.equal(report.counts.processingCompletionPercent,75);assert.equal(report.counts.successPercent,25);
  assert.equal(report.snapshotAt,"snapshot");assert.equal(report.units[0].sourceId,"jpg");
  assert.equal(report.units[1].statusLabel,"跳过");
  assert.throws(()=>buildTaskReport({summary:task.summary}),/完整任务明细/);
});

test("partially applied paired review lists confirmed members without asserting all files succeeded",()=>{
  const report=buildTaskReport({taskId:"partial",items:[{id:"unit",status:"failed",result:{review:{members:[{id:"raw"},{id:"jpg"}],appliedIds:["raw"]}}}]});
  assert.equal(report.counts.affectedFiles,2);assert.equal(report.counts.confirmedReviewAppliedFiles,1);
  assert.deepEqual(report.units[0].confirmedAppliedIds,["raw"]);
  assert.equal(report.counts.successPercent,0);assert.equal(report.counts.processingCompletionPercent,100);
});

test("CSV includes every exception and unfinished unit and escapes formulas, commas and newlines",()=>{
  const report=buildTaskReport({taskId:"t",items:[{id:"done",status:"succeeded"},{id:"skip",status:"skipped",error:'=HYPERLINK("bad")'},
    {id:"failed",status:"failed",error:'原因,含逗号\n换行'},{id:"pending",status:"pending",result:{name:"  @formula"}}]},"now");
  const csv=taskExceptionsCsv(report);
  assert.ok(csv.startsWith("\ufeff"));assert.ok(!csv.includes('"done"'));
  for(const id of ["skip","failed","pending"]) assert.ok(csv.includes(`"${id}"`));
  assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes("'  @formula"));assert.ok(csv.includes('原因,含逗号\n换行'));
});

test("8000-unit report does not truncate the last exception or lose original records",()=>{
  const task={taskId:"large",items:Array.from({length:8000},(_,i)=>({id:String(i),status:i===7999?"failed":"succeeded",error:i===7999?"last":null}))};
  const original=JSON.stringify(task);const report=buildTaskReport(task);
  assert.equal(report.units.length,8000);assert.equal(report.counts.failed,1);
  assert.ok(taskExceptionsCsv(report).includes('"7999"'));assert.equal(JSON.stringify(task),original);
});
