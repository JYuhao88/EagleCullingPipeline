import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDecisionLocally, defaultTarget, filterCounts, groupJump, matchesFilter, nextUndecided, passRows, progress,
  rangeSelect, targetOrder, targetPlan } from "../src/plugin/cull-model.js";
import { adjustmentFilterMarkup, adjustmentsAreIdentity, autoExposure, channelGains, normalizeAdjustments,
  toneCurve } from "../src/plugin/adjust.js";
import { restore, save, restoreWithFallback } from "../src/plugin/review-session.js";
import { handleAdjustmentsRoute } from "../src/server/adjustments-routes.js";
import { RunStore } from "../src/server/run-store.js";

function rows() {
  const out = [];
  const groups = [[0.9, 0.8, 0.4], [0.7], [0.85, 0.3], [0.6, 0.55]];
  groups.forEach((scores, groupIndex) => scores.forEach((score, i) => out.push({
    unitId: `u${groupIndex}-${i}`, groupId: `g${groupIndex}`, groupIndex, rank: i + 1, groupSize: scores.length, score,
    suggested: i === 0 ? "selected" : score < 0.5 ? "rejected" : "candidate", human: null, flags: [],
    confidence: groupIndex === 3 ? "low" : "high", margin: 0.1, reasons: [] })));
  out[2].flags = ["eyes-closed"];
  return out;
}

test("filters and counts follow the queue row semantics", () => {
  const list = rows();
  list[1].human = "selected";
  const counts = filterCounts(list);
  assert.equal(counts.all, 8);
  assert.equal(counts.undecided, 7);
  assert.equal(counts.issues, 1);
  assert.equal(counts.uncertain, 2);
  assert.equal(counts.rejects, 2);
  assert.equal(counts.picked, 5);
  assert.equal(matchesFilter({ suggested: "rejected", human: "selected" }, "rejects"), false);
  assert.deepEqual(progress(list), { decided: 1, total: 8, selected: 5, candidate: 1, rejected: 2 });
});

test("target plan keeps each group's best first and only reviews the boundary", () => {
  const list = rows();
  assert.deepEqual(targetOrder(list).slice(0, 4).map(row => row.unitId), ["u0-0", "u2-0", "u1-0", "u3-0"]);
  assert.equal(defaultTarget(list), 4);
  const plan = targetPlan(list, 4);
  assert.equal(plan.keep, 4);
  assert.ok(plan.keepIds.has("u3-0") && !plan.keepIds.has("u0-1"));
  const reviewed = new Set(plan.review.map(row => row.unitId));
  for (const item of plan.rest) assert.ok(!reviewed.has(item.unitId));
  assert.equal(plan.review.length + plan.rest.length, list.length);
  list[7].human = "rejected";
  const later = targetPlan(list, 1);
  assert.ok(later.rest.every(item => item.unitId !== "u3-1"), "human decisions are never overwritten");
  assert.ok(later.rest.every(item => item.action === (later.keepIds.has(item.unitId) ? "selected" : "rejected")));
});

test("passes, navigation and range selection", () => {
  const list = rows();
  assert.deepEqual(passRows(list, "rejects").map(row => row.unitId), ["u0-2", "u2-1"]);
  assert.equal(passRows(list, "compare").length, 7);
  assert.deepEqual(passRows(list, "picks").map(row => row.unitId), ["u0-0", "u1-0", "u2-0", "u3-0"]);
  assert.equal(groupJump(list, 0, 1), 3);
  assert.equal(groupJump(list, 5, -1), 3);
  assert.equal(groupJump(list, 3, -1), 0);
  assert.equal(groupJump(list, 7, 1), 7);
  list[1].human = "candidate";
  assert.equal(nextUndecided(list, 0), 2);
  list.forEach(row => { row.human = "selected"; });
  assert.equal(nextUndecided(list, 0), -1);
  assert.deepEqual(rangeSelect(list, "u2-1", "u0-2"), ["u0-2", "u1-0", "u2-0", "u2-1"]);
  const row = applyDecisionLocally({ suggested: "candidate", human: "rejected" }, "clear");
  assert.equal(row.human, null);
  assert.equal(row.action, "candidate");
});

test("view-only adjustment math is monotonic, identity-safe and physically ordered", () => {
  assert.equal(adjustmentsAreIdentity({ exposure: 0, contrast: 0.001 }), true);
  assert.deepEqual(normalizeAdjustments({ exposure: 9, shadows: -2, bogus: 1 }), { exposure: 3, shadows: -1 });
  const identity = toneCurve({});
  identity.forEach((value, i) => assert.ok(Math.abs(value - i / (identity.length - 1)) < 1e-9));
  for (const value of [{ contrast: 1 }, { contrast: -1 }, { shadows: 1, highlights: -1 }, { shadows: -1, highlights: 1 }]) {
    const curve = toneCurve(value);
    assert.equal(curve[0], 0);
    assert.ok(Math.abs(curve.at(-1) - 1) < 1e-9);
    curve.slice(1).forEach((y, i) => assert.ok(y >= curve[i], `monotonic for ${JSON.stringify(value)}`));
  }
  assert.ok(toneCurve({ shadows: -1 })[8] < identity[8], "negative shadows darken the lower third");
  assert.ok(toneCurve({ shadows: 1 })[8] > identity[8]);
  assert.ok(toneCurve({ highlights: -1 })[24] < identity[24]);
  assert.ok(toneCurve({ contrast: 1 })[8] < identity[8] && toneCurve({ contrast: 1 })[24] > identity[24]);
  assert.equal(channelGains({ exposure: 1 }).g, 2);
  const warm = channelGains({ temperature: 1 });
  assert.ok(warm.r > 1 && warm.b < 1);
  const markup = adjustmentFilterMarkup({ exposure: 1, saturation: -1 }, "x");
  assert.match(markup, /<filter id="x"/);
  assert.match(markup, /color-interpolation-filters="linearRGB"><feFuncR type="linear" slope="2"/);
  assert.match(markup, /type="saturate" values="0"/);
  assert.equal(autoExposure([]), 0);
  assert.ok(autoExposure(Array(9).fill(0.2)) > 0.9, "dark frame is brightened");
  assert.ok(autoExposure(Array(9).fill(0.8)) < -0.9, "bright frame is darkened");
  assert.ok(Math.abs(autoExposure(Array(9).fill(0.4614))) < 0.02, "middle grey stays put");
});

test("review sessions restore per task and fall back to the nearest undecided photo", () => {
  const storage = new Map();
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  save("run", { method: "grid", unitId: "b" }, store);
  assert.equal(restore("run", store).method, "grid");
  assert.equal(restore("other", store), null);
  const decisions = [{ unitId: "b", source: "human" }];
  assert.equal(restoreWithFallback("run", { ids: ["a", "b", "c"], decisions, storage: store }).unitId, "c");
});

test("adjustment route validates, persists per task and deletes empty values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adjustments-"));
  const runStore = new RunStore(path.join(root, "runs"));
  await runStore.save({ id: "run-adjust", status: "completed" },
    { run: { id: "run-adjust", status: "completed" }, units: [], results: [], groups: [], items: [] });
  const request = async (method, url, body) => {
    let result;
    const res = { writeHead: status => { res.status = status; }, end: value => { result = value; } };
    const handled = await handleAdjustmentsRoute({ method, url }, res, { runStore, readBody: async () => body,
      json: (target, status, value) => { target.writeHead(status); target.end(JSON.stringify(value)); return true; } });
    return { handled, status: res.status, value: result && JSON.parse(result) };
  };
  assert.equal((await request("PUT", "/runs/run-adjust/adjustments/u%3Aa", { exposure: 1.5, tint: 0.2 })).status, 200);
  assert.deepEqual((await request("GET", "/runs/run-adjust/adjustments")).value, { "u:a": { exposure: 1.5, tint: 0.2 } });
  const stored = JSON.parse(await readFile(path.join(runStore.dir("run-adjust"), "adjustments.json"), "utf8"));
  assert.deepEqual(stored, { "u:a": { exposure: 1.5, tint: 0.2 } });
  assert.equal((await request("PUT", "/runs/run-adjust/adjustments/u%3Aa", { exposure: 7 })).status, 400);
  assert.equal((await request("PUT", "/runs/run-adjust/adjustments/u%3Aa", { gamma: 1 })).status, 400);
  assert.equal((await request("PUT", "/runs/run-adjust/adjustments/u%3Aa", {})).status, 200);
  assert.deepEqual((await request("GET", "/runs/run-adjust/adjustments/u%3Aa")).value, {});
  assert.equal((await request("GET", "/runs/missing/adjustments")).status, 404);
  assert.equal((await request("GET", "/runs/run-adjust/queue")).handled, false);
});
