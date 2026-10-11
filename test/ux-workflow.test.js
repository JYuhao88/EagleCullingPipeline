import test from "node:test";
import assert from "node:assert/strict";
import { defaultRepository, serviceCommand, serviceOptions, progressEstimate } from "../src/plugin/service-start.js";
import { initialState, filteredGroups, reviewProgress } from "../src/plugin/state.js";
import { keyboardAction } from "../src/plugin/keyboard.js";

test("default repository is derived from the file:// plugin location", () => {
  assert.equal(defaultRepository({ protocol: "file:", pathname: "/home/test-user/My%20Repo/src/plugin/index.html" }),
    "/home/test-user/My Repo");
  assert.equal(defaultRepository({ protocol: "http:", pathname: "/index.html" }), "");
  assert.equal(defaultRepository({ protocol: "file:", pathname: "/tmp/index.html" }), "");
});

test("service command quotes absolute repository paths and matches spawn port", () => {
  assert.equal(serviceCommand("/tmp/a'b", "http://127.0.0.1:54321"),
    "cd '/tmp/a'\\''b' && nice -n 15 node src/cli.js serve --concurrency 1 --port 54321");
  assert.deepEqual(serviceOptions("/tmp/repo", "http://localhost:54321"), { cwd: "/tmp/repo", port: 54321 });
  assert.throws(() => serviceOptions("relative", "http://localhost"), /绝对路径/);
  assert.throws(() => serviceOptions("/tmp/repo", "http://remote:43125"), /本机/);
});

test("metric ETA uses elapsed work but does not claim a finalization estimate", () => {
  const run = { startedAt: "2026-10-09T00:00:00Z", progress: { stage: "metrics", completed: 2, total: 10 } };
  const now = Date.parse(run.startedAt) + 10000;
  assert.equal(progressEstimate(run, now), 40);
  assert.equal(progressEstimate({ ...run, progress: { ...run.progress, stage: "grouping" } }, now), null);
  assert.equal(progressEstimate({ progress: run.progress }, now), null);
});

test("default multi filter and progress count use the same groups", () => {
  const state = { ...initialState, data: { groups: [
    { id: "g1", unitIds: ["a", "b"] }, { id: "g2", unitIds: ["c"] }
  ] }, decisions: [{ unitId: "a", source: "human" }, { unitId: "b", source: "human" }] };
  assert.deepEqual(filteredGroups(state).map(group => group.id), ["g1"]);
  assert.deepEqual(reviewProgress(state), { reviewed: 1, total: 1 });
  assert.deepEqual(reviewProgress({ ...state, filter: "all" }), { reviewed: 1, total: 2 });
});

test("group correction shortcuts distinguish adjacent movement and new groups", () => {
  assert.deepEqual(keyboardAction({ key: "M" }), { type: "moveUnit", delta: -1 });
  assert.deepEqual(keyboardAction({ key: "m", shiftKey: true }), { type: "moveUnit", delta: 1 });
  assert.deepEqual(keyboardAction({ key: "G" }), { type: "newGroup" });
  assert.equal(keyboardAction({ key: "g" }, true), null);
});

import { refreshGroups } from "../src/plugin/state.js";
import { unreviewedSuggestions } from "../src/plugin/batch.js";

test("accepting suggestions skips existing human decisions even in partially reviewed groups", () => {
  const groups = [{ unitIds: ["a", "b"], suggested: { a: "selected", b: "candidate" } },
    { unitIds: ["c"], suggested: { c: "selected" } }];
  const decisions = [{ unitId: "a", action: "rejected", source: "human" }];
  assert.deepEqual(unreviewedSuggestions(groups, decisions).map(row => [row.unitId, row.action]),
    [["b", "candidate"], ["c", "selected"]]);
  assert.deepEqual(unreviewedSuggestions(groups.filter(group => group.unitIds.length === 1), decisions)
    .map(row => row.unitId), ["c"]);
});

test("group refresh follows moved unit, clamps hidden focus and retains decision undo history", () => {
  const history = [[{ unitId: "a", decision: null }]];
  const state = { ...initialState, filter: "all", groupIndex: 4, history, selected: ["a"] };
  const data = { groups: [{ id: "g1", unitIds: ["b", "c"] }, { id: "new", unitIds: ["a"] }] };
  const decisions = [{ unitId: "a", action: "rejected", source: "human" }];
  const refreshed = refreshGroups(state, data, decisions, "a");
  assert.equal(refreshed.groupIndex, 1);
  assert.equal(refreshed.unitIndex, 0);
  assert.equal(refreshed.history, history);
  assert.equal(refreshed.decisions, decisions);
  assert.deepEqual(refreshed.selected, []);
  const hidden = refreshGroups({ ...state, filter: "multi" }, data, decisions, "a");
  assert.equal(hidden.groupIndex, 0);
  assert.equal(hidden.unitIndex, 0);
});
