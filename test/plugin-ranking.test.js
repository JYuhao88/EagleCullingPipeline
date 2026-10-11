import test from "node:test";
import assert from "node:assert/strict";
import { highConfidenceGroups, labeledGroupCount } from "../src/plugin/batch.js";
import { initialState, filteredGroups, applyDecisionBatch, decisionSnapshot, undoDecision } from "../src/plugin/state.js";
import { personalizationText, createPersonalization } from "../src/plugin/personalization.js";
import { reviewGroups } from "../src/server/runs-routes.js";

const groups = [
  { id: "high", confidence: "high", unitIds: ["a", "b"] },
  { id: "partial", confidence: "high", unitIds: ["c", "d"] },
  { id: "low", confidence: "low", unitIds: ["e", "f"] },
  { id: "single", confidence: "single", unitIds: ["g"] }
];

test("low-first keeps multi-unit groups in stable confidence order", () => {
  const state = { ...initialState, data: { groups }, filter: "low-first" };
  assert.deepEqual(filteredGroups(state).map(group => group.id), ["low", "high", "partial"]);
  assert.equal(groups[0].id, "high");
});

test("high confidence batch excludes partially reviewed groups and supports one undo", () => {
  const decisions = [{ unitId: "c", source: "human", action: "selected" }];
  const targets = highConfidenceGroups(groups, decisions).flatMap(group => group.unitIds);
  assert.deepEqual(targets, ["a", "b"]);
  const state = { ...initialState, decisions };
  const next = applyDecisionBatch(state, targets.map(unitId => ({ unitId, action: "selected", source: "human" })),
    decisionSnapshot(state, targets));
  const undone = undoDecision(next);
  assert.deepEqual(undone.state.decisions, decisions);
  assert.deepEqual(undone.requests, targets.map(unitId => ({ unitId, clear: true })));
});

test("old run confidence and close-score reason are computed without changing stored groups", () => {
  const data = { groups: [{ id: "old", unitIds: ["a", "b"], ranking: [
    { unitId: "b", rank: 2, score: 0.8 }, { unitId: "a", rank: 1, score: 0.81, reasons: ["综合分最高"] }
  ] }], results: [] };
  const original = structuredClone(data);
  const [group] = reviewGroups(data);
  assert.equal(group.confidence, "low");
  assert.equal(group.margin, 0.01);
  assert.ok(group.ranking[1].reasons.includes("与第二名很接近，建议人工确认"));
  assert.deepEqual(data, original);
});

const report = { ready: true, labeledGroups: 5, remainingGroups: 2,
  before: { pairwise: { rate: 0.6 } }, after: { pairwise: { rate: 0.8 } } };

test("personalization prompt requires finite metrics and eligible labels", () => {
  assert.match(personalizationText(report), /5 组.*60% → 80%.*2 组/);
  assert.equal(personalizationText({ ...report, after: null }), "");
  assert.equal(personalizationText({ ...report, remainingGroups: 0 }), "");
  assert.equal(personalizationText({ ...report, ready: false }), "");
  assert.equal(labeledGroupCount(groups, [{ unitId: "a", action: "selected", source: "suggested" }]), 0);
  assert.equal(labeledGroupCount(groups, ["a", "b"].map(unitId => ({ unitId, action: "selected", source: "human" }))), 0);
});

test("personalization ignore lasts across refreshes in the session", async () => {
  const elements = new Map();
  const root = { querySelector: id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, addEventListener: (event, fn) => {
      elements.get(id)[event] = fn;
    } });
    return elements.get(id);
  } };
  const data = { groups: Array.from({ length: 5 }, (_, index) => ({ unitIds: [`a${index}`, `b${index}`] })) };
  const current = { runId: "run", data, decisions: data.groups.map(group => ({
    unitId: group.unitIds[0], action: "selected", source: "human"
  })) };
  let calls = 0;
  const prompt = createPersonalization({ root, state: () => current, api: async () => { calls += 1; return report; } });
  await prompt.refresh();
  assert.equal(elements.get("#personalizeBanner").hidden, false);
  elements.get("#personalizeIgnore").click();
  await prompt.refresh();
  assert.equal(elements.get("#personalizeBanner").hidden, true);
  assert.equal(calls, 1);
});

test("personalization apply refreshes run data and preserves undo history", async () => {
  const elements = new Map();
  const root = { querySelector: id => {
    if (!elements.has(id)) elements.set(id, { addEventListener: (event, fn) => { elements.get(id)[event] = fn; } });
    return elements.get(id);
  } };
  const history = [[{ unitId: "a", decision: null }]];
  let current = { runId: "run", data: { groups: [] }, decisions: [], history, groupIndex: 1 };
  const updated = { groups: [{ id: "new", unitIds: ["a", "b"] }] };
  const decisions = [{ unitId: "a", action: "selected", source: "human" }];
  const calls = [];
  let rendered = 0;
  createPersonalization({ root, state: () => current, setState: next => { current = next; },
    render: () => { rendered += 1; }, api: async (url, options) => {
      calls.push([url, options?.method]);
      if (url.endsWith("/apply")) return { changedGroups: 1 };
      if (url.endsWith("/results")) return updated;
      return { decisions };
    } });
  await elements.get("#personalizeApply").click();
  assert.deepEqual(calls, [["/runs/run/personalize/apply", "POST"],
    ["/runs/run/results", undefined], ["/runs/run/decisions", undefined]]);
  assert.equal(current.data, updated);
  assert.equal(current.decisions, decisions);
  assert.equal(current.history, history);
  assert.equal(current.groupIndex, 1);
  assert.equal(rendered, 1);
  assert.equal(elements.get("#personalizeBanner").hidden, true);
  assert.equal(elements.get("#personalizeApply").disabled, false);
});
