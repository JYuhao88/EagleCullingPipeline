import assert from "node:assert/strict";
import test from "node:test";
import { taskHistoryPage } from "../src/plugin/task-history.js";

test("task history pages all records and finds older restoration tasks in Chinese",()=>{
  const tasks=Array.from({length:801},(_,index)=>({taskId:`task-${index}`,taskType:index===800 ? "restore-thumbnails" : "analyze-selection",status:"succeeded"}));
  const last=taskHistoryPage(tasks,{page:100});
  assert.equal(last.total,801);assert.equal(last.pages,41);assert.equal(last.page,40);
  assert.equal(last.items[0].taskId,"task-800");
  const seen=Array.from({length:41},(_,page)=>taskHistoryPage(tasks,{page}).items).flat();
  assert.equal(new Set(seen.map(task=>task.taskId)).size,801);
  assert.deepEqual(taskHistoryPage(tasks,{query:"恢复"}).items,[tasks[800]]);
  assert.equal(taskHistoryPage(tasks,{query:"已完成"}).total,801);
  assert.equal(taskHistoryPage(tasks,{query:"task-800"}).total,1);
  assert.equal(taskHistoryPage(tasks,{query:"missing",page:99}).page,0);
  assert.equal(tasks.length,801);
});
