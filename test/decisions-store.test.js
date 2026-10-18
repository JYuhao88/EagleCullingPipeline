import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionsStore } from "../src/core/decisions-store.js";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const result = { unitId: "unit:a", flags: [] };
const group = { unitIds: ["unit:a"], suggested: { "unit:a": "selected" } };

test("concurrent requests through separate decision stores preserve every update", async t => {
  const dir = await tempDir(t, "review-concurrent-");
  await Promise.all(Array.from({ length: 20 }, (_, index) => new DecisionsStore(dir).upsert([
    { unitId: `unit:${index}`, action: "selected" }
  ])));
  const rows = await new DecisionsStore(dir).read();
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map(row => row.unitId)).size, 20);
  await Promise.all([
    new DecisionsStore(dir).upsert([{ unitId: "unit:0", clear: true }]),
    new DecisionsStore(dir).upsert([{ unitId: "unit:1", action: "rejected" }])
  ]);
  const changed = await new DecisionsStore(dir).read();
  assert.equal(changed.length, 19);
  assert.equal(changed.find(row => row.unitId === "unit:1").action, "rejected");
});

test("decisions persist and fall back to suggestions", async t => {
  const dir = await tempDir(t, "review-");
  const store = new DecisionsStore(dir);
  assert.equal((await store.effective([result], [group]))[0].source, "suggested");
  await store.upsert([{ unitId: "unit:a", action: "rejected", flags: [] }]);
  assert.equal((await store.effective([result], [group]))[0].action, "rejected");
  assert.match(await readFile(path.join(dir, "decisions.json"), "utf8"), /rejected/);
});

test("clear removes human decision and restores suggestion", async t => {
  const store = new DecisionsStore(await tempDir(t, "review-clear-"));
  await store.upsert([{ unitId: "unit:a", action: "rejected", flags: [] }]);
  await store.upsert([{ unitId: "unit:a", clear: true }]);
  const effective = await store.effective([result], [group]);
  assert.equal(effective[0].action, "selected");
  assert.equal(effective[0].source, "suggested");
});

test("free reason roundtrip, batch rejection is atomic", async t => {
  const store = new DecisionsStore(await tempDir(t, "w10-reasons-")), reason = "</textarea><script>123</script> & 中文";
  for (const action of ["selected", "rejected"]) {
    await store.upsert([{ unitId: "unit:a", action, reason }]); assert.equal((await store.read())[0].reason, reason);
  }
  await store.upsert([{ unitId: "unit:b", action: "selected", reason: "字".repeat(500) }]);
  await assert.rejects(store.upsert([{ unitId: "unit:a", action: "selected" },
    { unitId: "unit:b", action: "rejected", reason: "字".repeat(501) }]), /500/);
  assert.equal((await store.read()).find(d => d.unitId === "unit:a").action, "rejected");
  await assert.rejects(store.upsert([{ unitId: "unit:a", reason: 5 }]), /string/);
});
