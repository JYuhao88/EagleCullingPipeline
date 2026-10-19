import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWriteback, planWriteback, planRevertWriteback, writebackRecords, revertedRecords, withLiveTags
} from "../src/core/writeback.js";

function fixture() {
  return {
    units: [{ id: "unit:a", itemIds: ["a", "raw"] }],
    results: [{ unitId: "unit:a", flags: ["blurry"] }],
    decisions: [{ unitId: "unit:a", action: "rejected" }],
    items: [{ id: "a", name: "照片", tags: ["人工", "AI精选"] }, { id: "raw", tags: ["AI淘汰", "AI模糊"] }]
  };
}

test("writeback preview counts exact AI changes by action and records previous tags", async () => {
  const plan = planWriteback(fixture());
  const preview = await applyWriteback(plan, { updateItem() { assert.fail("preview must not write"); } });
  assert.equal(preview.summary.changed, 1);
  assert.equal(preview.summary.unchanged, 1);
  assert.equal(preview.summary.addedTags, 2);
  assert.equal(preview.summary.removedTags, 1);
  assert.deepEqual(preview.summary.byAction.rejected, { changed: 1, unchanged: 1, addedTags: 2, removedTags: 1 });
  assert.equal(preview.results[0].fileName, "照片");
  assert.deepEqual(preview.results[0].addedTags, ["AI淘汰", "AI模糊"]);
  assert.deepEqual(preview.results[0].removedTags, ["AI精选"]);
  const result = await applyWriteback(plan, { updateItem: async () => {} }, { apply: true });
  assert.deepEqual(writebackRecords(plan, result)[0].previousTags, ["人工", "AI精选"]);
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

test("revert restores only managed AI tags and preserves live user tags and metadata", async () => {
  const applied = [{ id: "a", previousTags: ["写回前用户标签", "AI精选"], tags: ["AI淘汰", "AI模糊"] }];
  const items = [{ id: "a", tags: ["新用户标签", "AI自定义", "AI淘汰", "AI模糊"], star: 5, folders: ["folder"] }];
  const plan = planRevertWriteback({ applied, items });
  assert.deepEqual(plan.items[0].tags, ["新用户标签", "AI自定义", "AI精选"]);
  const calls = [];
  const result = await applyWriteback(plan, { updateItem: async item => calls.push(item) }, { apply: true });
  assert.deepEqual(calls, [{ id: "a", tags: ["新用户标签", "AI自定义", "AI精选"] }]);
  assert.deepEqual(items[0].folders, ["folder"]);
  assert.equal(items[0].star, 5);
  assert.ok(revertedRecords(applied, result)[0].revertedAt);
});

test("repeated revert is idempotent, including subsequent user AI tag edits", async () => {
  const applied = [{ id: "a", previousTags: ["AI精选"], tags: ["AI淘汰"] }];
  const items = [{ id: "a", tags: ["用户", "AI淘汰"] }];
  let writes = 0;
  const api = { updateItem: async item => { writes += 1; items[0].tags = item.tags; } };
  const first = await applyWriteback(planRevertWriteback({ applied, items }), api, { apply: true });
  const records = revertedRecords(applied, first);
  items[0].tags.push("AI候选");
  const second = await applyWriteback(planRevertWriteback({ applied: records, items }), api, { apply: true });
  assert.equal(writes, 1);
  assert.equal(second.summary.unchanged, 1);
  assert.deepEqual(items[0].tags, ["用户", "AI精选", "AI候选"]);
});

test("legacy records without previousTags give an explicit error before planning", () => {
  assert.throws(() => planRevertWriteback({ applied: [{ id: "old", tags: ["AI精选"] }] }), /previousTags/);
  assert.throws(() => planRevertWriteback({}), /没有可撤回/);
});

test("revert preview is side effect free and failed items remain retryable", async () => {
  const applied = ["a", "b"].map(id => ({ id, previousTags: [], tags: ["AI精选"] }));
  const items = applied.map(({ id }) => ({ id, tags: ["人工", "AI精选"] }));
  const plan = planRevertWriteback({ applied, items });
  const api = { updateItem: async item => { if (item.id === "b") throw new Error("offline"); } };
  const preview = await applyWriteback(plan, api);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.results[0].changed, true);
  const result = await applyWriteback(plan, api, { apply: true });
  const records = revertedRecords(applied, result);
  assert.ok(records[0].revertedAt);
  assert.equal(records[1].revertedAt, undefined);
});

test("tag order alone has no changes and revert requires valid current tags", async () => {
  const data = fixture();
  data.items = [{ id: "a", tags: ["AI模糊", "AI淘汰", "人工"] }];
  assert.equal(planWriteback(data).summary.changed, 0);
  await assert.rejects(withLiveTags([{ id: "a" }], { itemInfo: async () => null }, { requireTags: true }), /当前标签/);
});

import { handleReviewRoute } from "../src/server/review-routes.js";

test("server revert persists successful records without modifying analysis snapshots", async () => {
  const data = { ...fixture(), run: { id: "run-test" }, applied: [
    { id: "a", previousTags: ["用户", "AI精选"], tags: ["AI淘汰"], fileName: "照片" }
  ] };
  const before = JSON.stringify({ groups: data.groups, results: data.results, items: data.items });
  const live = { a: ["用户后加", "AI淘汰"] };
  let writes = 0;
  const responses = [];
  const ctx = {
    runStore: {
      get: async () => data,
      dir: () => "/tmp/nonexistent-revert-decisions",
      saveApplied: async (_id, applied) => { data.applied = applied; }
    },
    api: {
      itemInfo: async id => ({ tags: live[id] }),
      updateItem: async ({ id, tags }) => { live[id] = tags; writes += 1; }
    },
    readBody: async () => ({}),
    json: (_res, status, body) => responses.push({ status, body })
  };
  const req = { method: "POST", url: "/runs/run-test/writeback/revert" };
  assert.equal(await handleReviewRoute(req, {}, ctx), true);
  assert.deepEqual(live.a, ["用户后加", "AI精选"]);
  assert.ok(data.applied[0].revertedAt);
  assert.equal(responses[0].body.revert, true);
  assert.equal(responses[0].body.dryRun, false);
  await handleReviewRoute(req, {}, ctx);
  assert.equal(writes, 1);
  assert.equal(responses[1].body.summary.unchanged, 1);
  assert.equal(JSON.stringify({ groups: data.groups, results: data.results, items: data.items }), before);
});

test("server refuses legacy revert records before querying Eagle", async () => {
  const ctx = {
    runStore: { get: async () => ({ run: { id: "old" }, applied: [{ id: "a" }] }), dir: () => "/tmp/unused" },
    api: { itemInfo: async () => assert.fail("legacy revert must fail before reading current tags") },
    readBody: async () => ({})
  };
  await assert.rejects(handleReviewRoute({ method: "POST", url: "/runs/old/writeback/revert" }, {}, ctx), /previousTags/);
});

test("same-run apply and revert serialize and revert re-reads the newest applied record", async () => {
  const data = { ...fixture(), run: { id: "concurrent" }, applied: [], groups: [
    { id: "g", unitIds: ["unit:a"], suggested: { "unit:a": "rejected" } }
  ] };
  const live = Object.fromEntries(data.items.map(item => [item.id, [...item.tags]]));
  let unblock;
  let entered;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let writes = 0;
  let reads = 0;
  const ctx = {
    runStore: {
      get: async () => ({ ...data, applied: [...data.applied] }),
      dir: () => "/tmp/nonexistent-concurrent-decisions",
      saveApplied: async (_id, applied) => { data.applied = applied; }
    },
    api: {
      itemInfo: async id => { reads += 1; return { tags: live[id] }; },
      updateItem: async ({ id, tags }) => {
        writes += 1;
        if (writes === 1) { entered(); await blocked; }
        live[id] = tags;
      }
    },
    readBody: async req => req.body,
    json: () => {}
  };
  const apply = handleReviewRoute({ method: "POST", url: "/runs/concurrent/apply", body: { apply: true } }, {}, ctx);
  await started;
  const revert = handleReviewRoute({ method: "POST", url: "/runs/concurrent/writeback/revert", body: {} }, {}, ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 2);
  unblock();
  await Promise.all([apply, revert]);
  assert.deepEqual(live.a, ["人工", "AI精选"]);
  assert.equal(writes, 2);
  assert.ok(data.applied.every(record => record.revertedAt));
  assert.equal(ctx.writebackPending.size, 0);
});

test("normal apply rejects malformed live tags without writing and releases its request queue", async () => {
  const data = { ...fixture(), groups: [], run: { id: "bad-tags" }, applied: [] };
  let malformed = true;
  let writes = 0;
  const ctx = {
    runStore: {
      get: async () => data,
      dir: () => "/tmp/nonexistent-bad-tag-decisions",
      saveApplied: async (_id, applied) => { data.applied = applied; }
    },
    api: {
      itemInfo: async () => malformed ? {} : { tags: ["用户"] },
      updateItem: async () => { writes += 1; }
    },
    readBody: async () => ({ apply: true }),
    json: () => {}
  };
  const req = { method: "POST", url: "/runs/bad-tags/apply" };
  await assert.rejects(handleReviewRoute(req, {}, ctx), /当前标签/);
  assert.equal(writes, 0);
  assert.equal(ctx.writebackPending.size, 0);
  malformed = false;
  assert.equal(await handleReviewRoute(req, {}, ctx), true);
  assert.equal(writes, 2);
});

test('normal apply without live history retains the previous latest-write snapshot semantics', async () => {
  const data = { ...fixture(), run: { id: 'normal-cycle' }, applied: [], groups: [
    { id: 'g', unitIds: ['unit:a'], suggested: { 'unit:a': 'selected' } }
  ] };
  const live = new Map(data.items.map(item => [item.id, [...item.tags]]));
  const ctx = { runStore: { get: async () => data, dir: () => '/tmp/nonexistent-normal-cycle-decisions',
    saveApplied: async (_id, records) => { data.applied = records; } }, readBody: async () => ({ apply: true }),
    json() {}, api: { itemInfo: async id => ({ tags: live.get(id) }), updateItem: async row => live.set(row.id, row.tags) } };
  await handleReviewRoute({ method: 'POST', url: '/runs/normal-cycle/apply' }, {}, ctx);
  const afterFirst = [...live.get('a')];
  data.groups[0].suggested['unit:a'] = 'rejected';
  await handleReviewRoute({ method: 'POST', url: '/runs/normal-cycle/apply' }, {}, ctx);
  assert.deepEqual(data.applied.find(row => row.id === 'a').previousTags, afterFirst);
  assert.equal(data.applied.some(row => row.live), false);
});

test("a tag rewrite keeps 留存 on 留存 photos and never adds it elsewhere", () => {
  const base = fixture();
  const kept = planWriteback({ ...base, decisions: [{ unitId: "unit:a", action: "record", source: "human" }] });
  assert.ok(kept.items.every(item => item.tags.includes("留存")));
  assert.ok(kept.items.every(item => !item.tags.some(tag => ["AI精选", "AI淘汰"].includes(tag))));
  const judged = planWriteback(base);
  assert.ok(judged.items.every(item => !item.tags.includes("留存")));
});
