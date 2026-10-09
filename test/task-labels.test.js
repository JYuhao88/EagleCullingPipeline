import assert from "node:assert/strict";
import test from "node:test";
import { taskLabels } from "../src/plugin/task-labels.js";

test("task display localizes protocol types and keeps staged/cancelled states truthful",()=>{
  const task={taskType:"review-units",status:"paused",activationPending:true};
  assert.deepEqual(taskLabels(task),{type:"人工审阅（同步配对）",status:"待确认启动"});
  assert.equal(taskLabels({...task,status:"cancelled"}).status,"已取消","cancelled staged plans are not pending confirmation");
  assert.equal(taskLabels({...task,status:"uploading"}).status,"计划上传中");
  assert.equal(taskLabels({...task,activationPending:false}).status,"已暂停");
  assert.equal(taskLabels({taskType:"analyze-selection",status:"succeeded"}).type,"照片分析");
  assert.match(taskLabels({taskType:"unexpected",status:"unknown"}).status,/未知状态/);
  assert.deepEqual(task,{taskType:"review-units",status:"paused",activationPending:true},"display must not mutate persisted protocol data");
});
