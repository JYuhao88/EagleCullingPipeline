import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyGroupOverrides } from "../src/core/group-overrides.js";
import { DecisionsStore } from "../src/core/decisions-store.js";
import { RunStore } from "../src/server/run-store.js";
import { handleGroupRoute } from "../src/server/group-routes.js";

const results = [
  { unitId: "a", metrics: { quality: 0.4 }, flags: [] },
  { unitId: "b", metrics: { quality: 0.9 }, flags: [] },
  { unitId: "c", metrics: { quality: 0.7 }, flags: [] },
];
const groups = [
  { id: "g1", unitIds: ["a", "b"], suggested: { a: "candidate", b: "selected" } },
  { id: "g2", unitIds: ["c"], suggested: { c: "selected" } },
];

test("move, split and merge replay without mutating source and refresh suggestions", () => {
  const before = JSON.stringify({ groups, results });
  const moved = applyGroupOverrides(groups, results, [{ type: "move", unitId: "b", targetGroupId: "g2" }]);
  assert.deepEqual(moved.map(group => group.unitIds), [["a"], ["c", "b"]]);
  assert.equal(moved[1].ranking[0].unitId, "b");
  assert.equal(moved[1].suggested.b, "selected");
  assert.equal(moved[1].suggested.c, "candidate");
  const operations = [
    { type: "split", groupId: "g1", unitIds: ["b"], newGroupId: "g3" },
    { type: "merge", groupIds: ["g3", "g2"] },
  ];
  assert.deepEqual(applyGroupOverrides(groups, results, operations).map(group => group.unitIds), [["a"], ["b", "c"]]);
  assert.equal(JSON.stringify({ groups, results }), before);
  assert.deepEqual(applyGroupOverrides(groups, results, []), groups);
});

test("invalid edits cannot duplicate or lose units", () => {
  assert.throws(() => applyGroupOverrides(groups, results, [{ type: "move", unitId: "z", targetGroupId: "g2" }]));
  assert.throws(() => applyGroupOverrides(groups, results, [{ type: "move", unitId: "a", targetGroupId: "g1" }]));
  assert.throws(() => applyGroupOverrides(groups, results, [{ type: "split", groupId: "g1", unitIds: ["a", "b"] }]));
  assert.throws(() => applyGroupOverrides(groups, results, [{ type: "merge", groupIds: ["g1", "g1"] }]));
});

test("corrected groups preserve safety gates when a flagged choice has the highest quality score", () => {
  const flagged = results.map(result => result.unitId === "b" ? { ...result, flags: ["blurry"] } : result);
  const revised = applyGroupOverrides(groups, flagged, [{ type: "merge", groupIds: ["g1", "g2"] }]);
  assert.equal(revised[0].ranking[0].unitId, "c");
  assert.equal(revised[0].suggested.c, "selected");
  assert.equal(revised[0].suggested.b, "rejected");
});

test("persisted edits serialize, undo replays original results and retains human decisions", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "culling-overrides-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  const run = { id: "test", status: "completed" };
  await store.save(run, { run, groups, results });
  const original = await readFile(path.join(store.dir(run.id), "results.json"), "utf8");
  const decisions = new DecisionsStore(store.dir(run.id));
  await decisions.upsert([{ unitId: "b", action: "rejected" }]);
  await Promise.all([
    store.mutateGroups(run.id, "move", { unitId: "a", targetGroupId: "new" }),
    store.mutateGroups(run.id, "move", { unitId: "b", targetGroupId: "g2" }),
  ]);
  let data = await new RunStore(root).get(run.id);
  assert.equal(data.groupOverrides.operations.length, 2);
  assert.equal(data.groups.length, 2);
  assert.equal((await decisions.effective(data.results, data.groups)).find(item => item.unitId === "b").action, "rejected");
  await store.mutateGroups(run.id, "undo");
  await store.mutateGroups(run.id, "undo");
  await store.mutateGroups(run.id, "undo");
  data = await store.get(run.id);
  assert.deepEqual(data.groups, groups);
  assert.equal((await decisions.effective(data.results, data.groups)).find(item => item.unitId === "b").source, "human");
  await store.saveApplied(run.id, [{ id: "a", previousTags: ["user"] }]);
  assert.equal(await readFile(path.join(store.dir(run.id), "results.json"), "utf8"), original);
  assert.equal((await store.applied(run.id))[0].id, "a");
  await assert.rejects(store.mutateGroups(run.id, "split", { groupId: "g1", unitIds: ["c"] }));
  assert.equal((await store.groupOverrides(run.id)).operations.length, 0);
  await writeFile(path.join(store.dir(run.id), "group-overrides.json"), "bad json");
  await assert.rejects(store.get(run.id), SyntaxError);
});

test("group endpoints validate input and refuse edits before analysis finishes", async () => {
  const replies = [];
  const ctx = {
    json: (_, status, body) => replies.push({ status, body }),
    readBody: async () => ({ groupId: "g1", unitIds: ["a"] }),
    runStore: { mutateGroups: async (_, type, body) => ({ type, body }) },
  };
  const request = { method: "POST", url: "/runs/test/groups/split" };
  assert.equal(await handleGroupRoute(request, {}, ctx, { run: { status: "running" } }), true);
  assert.equal(replies.at(-1).status, 409);
  await handleGroupRoute(request, {}, ctx, { run: { status: "completed" } });
  assert.equal(replies.at(-1).body.type, "split");
  assert.equal(await handleGroupRoute({ ...request, url: "/runs/test/decisions" }, {}, ctx, {}), false);
  ctx.runStore.mutateGroups = async () => { throw new Error("无效分组"); };
  await handleGroupRoute(request, {}, ctx, { run: { status: "completed" } });
  assert.equal(replies.at(-1).status, 400);
});

import { buildReport } from "../src/core/report.js";
import { planWriteback } from "../src/core/writeback.js";

test("report and writeback consume corrected suggestions while human decisions remain authoritative", () => {
  const corrected = applyGroupOverrides(groups, results, [{ type: "move", unitId: "b", targetGroupId: "g2" }]);
  const data = {
    groups: corrected, results, units: results.map(item => ({ id: item.unitId, itemIds: [item.unitId] })),
    items: results.map(item => ({ id: item.unitId, tags: ["用户"] })),
    decisions: [{ unitId: "b", action: "rejected", source: "human", flags: [] }]
  };
  const report = buildReport(data);
  assert.equal(report.find(item => item.unitId === "c").groupId, "g2");
  assert.equal(report.find(item => item.unitId === "c").suggested, "candidate");
  assert.equal(report.find(item => item.unitId === "a").suggested, "selected");
  assert.equal(report.find(item => item.unitId === "b").decision, "rejected");
  const plan = planWriteback(data);
  assert.deepEqual(plan.items.find(item => item.id === "a").tags, ["用户", "AI精选"]);
  assert.deepEqual(plan.items.find(item => item.id === "c").tags, ["用户", "AI候选"]);
  assert.deepEqual(plan.items.find(item => item.id === "b").tags, ["用户", "AI淘汰"]);
});

import { createRunsRouter } from "../src/server/runs-routes.js";

test("terminal run cancellation cannot overwrite corrected analysis snapshots", async () => {
  const router = createRunsRouter({ store: {
    get: async () => ({ run: { id: "done", status: "completed" }, groups: [] }),
    save: async () => assert.fail("completed snapshots must remain unchanged")
  } });
  let status;
  let body;
  const res = { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } };
  const url = new URL("http://localhost/runs/done/cancel");
  await router({ method: "POST", url: url.pathname }, res, url);
  assert.equal(status, 409);
  assert.match(body.error, /已结束/);
});
