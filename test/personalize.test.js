import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPersonalization, personalizeReport } from "../src/core/personalize.js";
import { rankGroup } from "../src/core/ranking.js";
import { DecisionsStore } from "../src/core/decisions-store.js";
import { RunStore } from "../src/server/run-store.js";
import { handleReviewRoute } from "../src/server/review-routes.js";

function fixture(count = 12) {
  const results = [];
  const groups = [];
  for (let index = 0; index < count; index += 1) {
    const items = [
      { unitId: `${index}-a`, metrics: { sharpness: 0.1, exposure: 0.9, quality: 0.9, faces: 1, eyesClosed: 0 } },
      { unitId: `${index}-b`, metrics: { sharpness: 0.9, exposure: 0.1, quality: 0.1, faces: 1, eyesClosed: 0 } },
    ];
    results.push(...items);
    groups.push({ id: `g${index}`, unitIds: items.map(item => item.unitId), ranking: rankGroup(items),
      suggested: { [`${index}-a`]: "selected", [`${index}-b`]: "candidate" } });
  }
  const decisions = groups.slice(0, 10).map(group => ({
    unitId: group.unitIds[1], action: "selected", source: "human",
    updatedAt: new Date(Date.UTC(2026, 0, 1 + groups.indexOf(group))).toISOString(),
  }));
  return { data: { run: { id: "test-run" }, groups, results, units: [], items: [] }, decisions };
}

test("personalization requires heldout evidence rather than a fixed start threshold", () => {
  const { data, decisions } = fixture();
  const report = personalizeReport(data, decisions.slice(0, 4));
  assert.equal(report.ready, false);
  assert.equal(report.neededGroups, null);
  assert.equal(report.weights, null);
  const result = applyPersonalization(data, decisions.slice(0, 4));
  assert.equal(result.changedGroups, 0);
  assert.equal(result.data, data);
});

test("personalization refuses insufficient complete temporal training groups", () => {
  const { data, decisions } = fixture();
  for (const result of data.results.slice(0, 16)) result.metrics.eyesClosed = null;
  const report = personalizeReport(data, decisions);
  assert.equal(report.ready, false);
  assert.equal(report.labeledGroups, 10);
  assert.equal(report.trainingGroups, 2);
  assert.equal(report.reason, "insufficient-data");
});

test("personalization evaluates fitted weights and preserves every partly reviewed group", () => {
  const { data, decisions } = fixture();
  decisions.push({ unitId: "10-a", action: "candidate", source: "human" });
  const original = structuredClone(data);
  const report = personalizeReport(data, decisions);
  assert.equal(report.ready, true);
  assert.equal(report.before.top1.rate, 0);
  assert.equal(report.after.top1.rate, 1);
  assert.equal(report.after.pairwise.rate, 1);
  assert.equal(report.remainingGroups, 1);
  const result = applyPersonalization(data, decisions, report);
  assert.deepEqual(data, original);
  assert.deepEqual(result.data.groups.slice(0, 11), original.groups.slice(0, 11));
  assert.equal(result.changedGroups, 1);
  assert.equal(result.data.groups[11].ranking[0].unitId, "11-b");
  assert.equal(result.data.groups[11].suggested["11-b"], "selected");
  assert.equal(result.data.groups[11].confidence, "high");
  assert.equal(applyPersonalization(result.data, decisions).changedGroups, 0);
});

async function routeFixture(t, count = 12) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-personalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runStore = new RunStore(root);
  const { data, decisions } = fixture(count);
  await runStore.save(data.run, data);
  const decisionStore = new DecisionsStore(runStore.dir(data.run.id));
  await decisionStore.write(decisions);
  const ctx = { runStore, json: (_res, status, body) => { ctx.response = { status, body }; } };
  const call = async (method, suffix) => {
    const handled = await handleReviewRoute({ method, url: `/runs/test-run/${suffix}` }, {}, ctx);
    assert.equal(handled, true);
    return ctx.response;
  };
  return { data, decisions, call, runStore, decisionStore };
}

test("personalize routes report metrics and apply only to this run without changing decisions", async t => {
  const { data, call, runStore, decisionStore } = await routeFixture(t);
  const originalDecisions = await readFile(decisionStore.file, "utf8");
  const preview = await call("GET", "personalize");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.labeledGroups, 10);
  assert.equal(preview.body.remainingGroups, 2);
  assert.equal(preview.body.applied, null);
  const applied = await call("POST", "personalize/apply");
  assert.equal(applied.status, 200);
  assert.equal(applied.body.changedGroups, 2);
  assert.equal(applied.body.applied.changedGroups, 2);
  assert.ok(Number.isFinite(Date.parse(applied.body.applied.at)));
  assert.deepEqual((await call("GET", "personalize")).body.applied, applied.body.applied);
  const persisted = await runStore.get(data.run.id);
  assert.deepEqual(persisted.groups.slice(0, 10), data.groups.slice(0, 10));
  assert.equal(persisted.groups[10].ranking[0].unitId, "10-b");
  assert.equal(await readFile(decisionStore.file, "utf8"), originalDecisions);
});

test("personalize undo restores original fields and refreshes run pages without changing decisions", async t => {
  const { data, call, runStore, decisionStore } = await routeFixture(t);
  const original = await runStore.get(data.run.id);
  const originalDecisions = await readFile(decisionStore.file, "utf8");
  await runStore.page(data.run.id, { groupId: "g10" });
  await runStore.unitData(data.run.id, "10-a");
  await call("POST", "personalize/apply");
  assert.equal((await runStore.page(data.run.id, { groupId: "g10" })).groups[0].ranking[0].unitId, "10-b");
  const undoFile = path.join(runStore.dir(data.run.id), "personalize-undo.json");
  const snapshot = JSON.parse(await readFile(undoFile, "utf8"));
  assert.equal(snapshot.groups.length, 2);
  assert.ok(snapshot.groups.every(group => !Object.hasOwn(group.fields, "unitIds")));
  assert.ok(snapshot.groups.every(group => group.absent.includes("candidateSet")));
  const undone = await call("POST", "personalize/undo");
  assert.equal(undone.status, 200);
  assert.equal(undone.body.changedGroups, 2);
  assert.deepEqual(await runStore.get(data.run.id), original);
  assert.deepEqual((await runStore.unitData(data.run.id, "10-a")).groups[0], original.groups[10]);
  assert.equal((await call("GET", "personalize")).body.applied, null);
  await assert.rejects(readFile(undoFile), { code: "ENOENT" });
  assert.equal(await readFile(decisionStore.file, "utf8"), originalDecisions);
  assert.deepEqual((await call("POST", "personalize/undo")).body, { applied: null, changedGroups: 0 });
});

test("repeated personalize apply preserves the first snapshot and undo returns to the initial run", async t => {
  const { data, call, runStore, decisionStore } = await routeFixture(t);
  const original = await runStore.get(data.run.id);
  const originalDecisions = await readFile(decisionStore.file, "utf8");
  const first = await call("POST", "personalize/apply");
  const undoFile = path.join(runStore.dir(data.run.id), "personalize-undo.json");
  const firstSnapshot = await readFile(undoFile, "utf8");
  const reranked = await runStore.get(data.run.id);
  reranked.groups[11].ranking[0].score -= 1;
  await runStore.save(reranked.run, reranked);
  const second = await call("POST", "personalize/apply");
  assert.equal(second.status, 200);
  assert.equal(second.body.changedGroups, 1);
  assert.deepEqual(second.body.applied, first.body.applied);
  assert.equal(await readFile(undoFile, "utf8"), firstSnapshot);
  await call("POST", "personalize/undo");
  assert.deepEqual(await runStore.get(data.run.id), original);
  assert.equal(await readFile(decisionStore.file, "utf8"), originalDecisions);
});

test("personalize apply returns 409 without enough independent temporal holdout groups", async t => {
  const { data, call, runStore, decisionStore } = await routeFixture(t);
  await decisionStore.write((await decisionStore.read()).slice(0, 4));
  const before = await readFile(path.join(runStore.dir(data.run.id), "results-index.json"), "utf8");
  const response = await call("POST", "personalize/apply");
  assert.equal(response.status, 409);
  assert.equal(response.body.ready, false);
  assert.equal(response.body.neededGroups, null);
  assert.equal(await readFile(path.join(runStore.dir(data.run.id), "results-index.json"), "utf8"), before);
});
