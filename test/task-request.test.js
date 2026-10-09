import assert from "node:assert/strict";
import test from "node:test";
import { taskRequestPath } from "../src/plugin/task-request.js";

test("status-only controls request summaries without stripping resume/retry plans", () => {
  for (const action of ["pause","cancel","configure","complete","fail"]) {
    assert.equal(taskRequestPath(`/tasks/test/${action}`,{method:"POST"}),`/tasks/test/${action}?includeItems=false`);
    assert.equal(taskRequestPath(`/tasks/test/${action}?includeItems=true`,{method:"POST"}),`/tasks/test/${action}?includeItems=true`);
  }
  for (const action of ["resume","retry","checkpoint","claim","heartbeat"]) {
    assert.equal(taskRequestPath(`/tasks/test/${action}`,{method:"POST"}),`/tasks/test/${action}`);
  }
  assert.equal(taskRequestPath("/tasks/test/pause"),"/tasks/test/pause");
  assert.equal(taskRequestPath("/tasks/test/pause?other=1",{method:"POST"}),"/tasks/test/pause?other=1&includeItems=false");
});
