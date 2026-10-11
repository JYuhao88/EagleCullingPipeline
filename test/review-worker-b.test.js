import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionsStore } from "../src/core/decisions-store.js";
import { planWriteback } from "../src/core/writeback.js";
import { buildReport, reportCsv } from "../src/core/report.js";

test('concurrent requests through separate decision stores preserve every update', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 20 }, (_, index) => new DecisionsStore(dir).upsert([
    { unitId: `unit:${index}`, action: 'selected' }
  ])));
  const rows = await new DecisionsStore(dir).read();
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map(row => row.unitId)).size, 20);
  await Promise.all([
    new DecisionsStore(dir).upsert([{ unitId: 'unit:0', clear: true }]),
    new DecisionsStore(dir).upsert([{ unitId: 'unit:1', action: 'rejected' }])
  ]);
  const changed = await new DecisionsStore(dir).read();
  assert.equal(changed.length, 19);
  assert.equal(changed.find(row => row.unitId === 'unit:1').action, 'rejected');
});

test("decisions persist and fall back to suggestions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-"));
  const store = new DecisionsStore(dir);
  const result = { unitId: "unit:a", flags: [] };
  const group = { unitIds: ["unit:a"], suggested: { "unit:a": "selected" } };
  assert.equal((await store.effective([result], [group]))[0].source, "suggested");
  await store.upsert([{ unitId: "unit:a", action: "rejected", flags: [] }]);
  assert.equal((await store.effective([result], [group]))[0].action, "rejected");
  assert.match(await readFile(path.join(dir, "decisions.json"), "utf8"), /rejected/);
});

test("writeback applies a unit decision to RAW and preserves human tags", () => {
  const plan = planWriteback({
    units: [{ id: "unit:a", itemIds: ["jpg", "raw"] }],
    results: [{ unitId: "unit:a", flags: ["blurry"] }],
    decisions: [{ unitId: "unit:a", action: "rejected", flags: [] }],
    items: [{ id: "jpg", tags: ["人工"] }, { id: "raw", tags: ["人工", "AI精选"] }]
  });
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items[1].tags, ["人工", "AI淘汰", "AI模糊"]);
});

test("report CSV has BOM and Chinese columns", () => {
  const csv = reportCsv(buildReport({
    units: [{ id: "unit:a", itemIds: ["a"], pairing: "single" }],
    results: [{ unitId: "unit:a", flags: [], metrics: {} }],
    groups: [{ id: "group:a", unitIds: ["unit:a"], ranking: [{ unitId: "unit:a", rank: 1, score: 1, reasons: ["清晰"] }] }],
    items: [{ id: "a", name: "照片", ext: "jpg", tags: [] }]
  }));
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /itemId,.*decisionSource/);
  assert.match(csv, /清晰/);
});

test("clear removes human decision and restores suggestion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-clear-"));
  const store = new DecisionsStore(dir);
  const result = { unitId: "unit:a", flags: [] };
  const group = { unitIds: ["unit:a"], suggested: { "unit:a": "selected" } };
  await store.upsert([{ unitId: "unit:a", action: "rejected", flags: [] }]);
  await store.upsert([{ unitId: "unit:a", clear: true }]);
  const effective = await store.effective([result], [group]);
  assert.equal(effective[0].action, "selected");
  assert.equal(effective[0].source, "suggested");
});
