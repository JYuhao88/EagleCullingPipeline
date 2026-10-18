import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAnalysisServer } from "../src/server.js";
import { RunStore } from "../src/server/run-store.js";
import { FeedbackStore, feedbackStats, effectiveFeedback } from "../src/server/feedback-store.js";
import { feedbackCatalog } from "../src/server/feedback-routes.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runStore = new RunStore(path.join(root, "runs"));
  const run = { id: "run-feedback", status: "completed", libraryPath: "/private/example.library" };
  await runStore.save(run, {
    units: ["a", "b"].map(id => ({ id: `unit:${id}`, itemIds: [id] })),
    items: ["a", "b"].map(id => ({ id, name: id, tags: [] })),
    results: [{ unitId: "unit:a", fingerprint: "abc", flags: ["blurry"],
    verdicts: [{ ruleId: "P-CROP-KNEE", verdict: "violate" }] }, { unitId: "unit:b", fingerprint: "def" }],
    groups: [{ id: "g", unitIds: ["unit:a", "unit:b"], ranking: [{ unitId: "unit:b", rank: 1 }],
    suggested: { "unit:a": "rejected", "unit:b": "selected" } }]
  });
  let writes = 0;
  const app = createAnalysisServer({ port: 0, runStore, pipeline: {}, api: { itemInfo: async id => ({ id, tags: [] }),
    updateItem: async () => { writes++; throw new Error("Eagle offline"); } } });
  await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined
    ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { root, runStore, request, get writes() { return writes; } };
}

test("feedback HTTP appends trusted records, amends reasons, undoes and reports statistics", async t => {
  const f = await fixture(t);
  const catalog = (await f.request("/api/feedback/catalog")).body;
  const reason = catalog.reasons.find(reason => reason.ruleIds.includes("P-CROP-KNEE"));
  assert.ok(reason);
  const route = "/runs/run-feedback/feedback";
  const first = await f.request(route, { unitId: "unit:a", action: "reject", reasons: [reason.id],
    itemIds: ["forged"], toolSuggestion: { decision: "keep" }, privateNote: "do not save" });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.event.itemIds, ["a"]);
  assert.equal(first.body.event.toolSuggestion.decision, "reject");
  assert.equal(first.body.event.privateNote, undefined);
  assert.ok(first.body.event.analysisSignature);
  const amended = await f.request(route, { unitId: "unit:a", action: "reject", reasons: [], replaces: first.body.event.id });
  assert.equal(amended.status, 201);
  let stats = (await f.request("/api/feedback/stats?runId=run-feedback")).body;
  assert.equal(stats.activeEvents, 1);
  assert.equal(stats.reasonVerdictAgreement.rate, null);
  const undo = await f.request(route, { unitId: "unit:a", action: "undo", reasons: [], undoOf: amended.body.event.id });
  assert.equal(undo.status, 201);
  stats = (await f.request("/api/feedback/stats?runId=run-feedback")).body;
  assert.equal(stats.reasonVerdictAgreement.rate, 1);
  await f.request(route, { unitId: "unit:a", action: "keep", reasons: [] });
  await f.request(route, { unitId: "unit:b", action: "reject", reasons: [] });
  const winner = await f.request(route, { unitId: "unit:a", action: "winner-change", reasons: [],
    prevWinner: "unit:b", newWinner: "unit:a" });
  assert.equal(winner.status, 201);
  stats = (await f.request("/api/feedback/stats?runId=run-feedback")).body;
  assert.deepEqual(stats.falseRejectProxy, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(stats.keepRejectedProxy.rate, 1);
  assert.equal(stats.winnerChangeRatio.rate, 0.25);
  assert.equal(stats.undoEvents, 1);
  const store = new FeedbackStore(path.join(f.root, "feedback"));
  const lines = (await readFile(store.file("/private/example.library"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 6);
  assert.ok(lines.every(line => !line.includes("example.library") && !line.includes("privateNote")));
  assert.equal(f.writes, 0);
});

test("feedback validates references, reasons, winner pairs and unknown units", async t => {
  const { request } = await fixture(t);
  for (const body of [
    { unitId: "unit:missing", action: "keep" },
    { unitId: "unit:a", action: "reject", reasons: ["unknown"] },
    { unitId: "unit:a", action: "undo" },
    { unitId: "unit:a", action: "undo", undoOf: "missing" },
    { unitId: "unit:a", action: "winner-change", prevWinner: "unit:a", newWinner: "unit:a" },
  ]) assert.equal((await request("/runs/run-feedback/feedback", body)).status, 400);
  assert.equal((await request("/api/feedback/stats?runId=missing")).status, 404);
  const stats = (await request("/api/feedback/stats")).body;
  assert.equal(stats.falseRejectProxy.rate, null);
  assert.equal(stats.winnerChangeRatio.rate, null);
});

test("Eagle failure cannot erase feedback and feedback storage failure cannot block writeback preview", async t => {
  const f = await fixture(t);
  await f.request("/runs/run-feedback/feedback", { unitId: "unit:b", action: "keep", reasons: [] });
  await f.request("/runs/run-feedback/decisions", { unitId: "unit:b", action: "selected", source: "human" });
  const apply = await f.request("/runs/run-feedback/apply", { apply: true });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.results.find(item => item.id === "b").ok, false);
  assert.ok(f.writes > 0);
  assert.equal((await f.request("/api/feedback/stats")).body.activeEvents, 1);
  await rm(path.join(f.root, "feedback"), { recursive: true });
  await writeFile(path.join(f.root, "feedback"), "blocking file");
  assert.equal((await f.request("/runs/run-feedback/feedback", { unitId: "unit:b", action: "reject", reasons: [] })).status, 400);
  assert.equal((await f.request("/runs/run-feedback/apply", { apply: false })).status, 200);
});

test("feedback append serialization preserves concurrent events and empty metrics are unknown", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feedback-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FeedbackStore(root);
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.append("lib", { unitId: `u${index}`, action: "keep", reasons: [] })));
  assert.equal((await store.read()).length, 20);
  assert.equal(feedbackStats([]).falseRejectProxy.rate, null);
  const events = [{ id: "a", action: "reject" }, { id: "b", action: "reject", replaces: "a" }, { id: "c", action: "undo", undoOf: "b" }];
  assert.deepEqual(effectiveFeedback(events).map(event => event.id), ["a"]);
  const catalog = await feedbackCatalog();
  assert.ok(catalog.rules.every(rule => rule.label));
  assert.equal(new Set(catalog.rules.map(rule => rule.id)).size, catalog.rules.length);
  assert.equal(catalog.rules.find(rule => rule.id === 'P-CROP-KNEE').title, '不切膝盖');
  assert.equal(catalog.rules.find(rule => rule.id === 'P-CROP-KNEE').severity, 'gate');
  const gate = feedbackStats([{ id: "gate", action: "reject", reasons: ["R-G-BLUR"],
    toolSuggestion: { gates: ["blurry"], violations: [] } }], [{ id: "R-G-BLUR", ruleIds: ["G-PROXY-BLUR"] }]);
  assert.equal(gate.reasonVerdictAgreement.rate, 1);
});

test('feedback caches isolate callers, observe other instances and surface external corruption', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'feedback-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new FeedbackStore(root), second = new FeedbackStore(root), library = '/cache-test.library';
  const body = { action: 'keep', unitId: 'a', reasons: ['original'] };
  const saved = await first.append(library, body);
  saved.reasons.push('mutation');
  const rows = await first.read(library); rows[0].reasons.push('another-mutation');
  assert.deepEqual((await first.read(library))[0].reasons, ['original']);
  await Promise.all([first.append(library, { ...body, unitId: 'b' }), second.append(library, { ...body, unitId: 'c' })]);
  assert.equal((await first.read(library)).length, 3);
  assert.equal((await second.read(library)).length, 3);
  await writeFile(first.file(library), 'corrupted history\n');
  await assert.rejects(() => first.read(library), SyntaxError);
});
