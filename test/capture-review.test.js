import assert from "node:assert/strict";
import test from "node:test";
import { buildCaptureIndex } from "../src/plugin/capture-units.js";
import { planCaptureReview, applyReviewUnit } from "../src/plugin/capture-review.js";
import { runBoundedQueue } from "../src/plugin/task-queue.js";
import { buildReviewSections } from "../src/plugin/review-model.js";

const pair = () => [
  { id: "jpg", name: "DSC001.JPG", ext: "jpg", folders: ["trip"], tags: ["人工", "AI候选"], modifiedAt: 1, star: 4 },
  { id: "raw", name: "DSC001", ext: "arw", folders: ["trip"], tags: ["人工RAW", "AI原片"], modifiedAt: 1, star: 2 },
];
function fakeApi(items, fail = () => false) {
  const saves = [];
  const byId = new Map(items.map((item) => [item.id, structuredClone(item)]));
  const api = { library: { path: "library" }, item: {
    async getById(id) {
      const original = byId.get(id);
      if (!original) return null;
      return { ...structuredClone(original), async save() {
        if (fail(id)) throw new Error("save failed");
        saves.push(id); original.tags = [...this.tags]; original.modifiedAt += 1; return true;
      } };
    },
    async getByIds(ids) { return Promise.all(ids.map((id) => api.item.getById(id))); },
  } };
  return { api, saves, byId };
}

test("pairing is conservative across the whole catalogue", () => {
  assert.equal(buildCaptureIndex(pair()).get("jpg").status, "paired");
  const hasselblad = pair().map((item, index) => ({ ...item, name: "B001", ext: index ? "3fr" : "heic" }));
  assert.equal(buildCaptureIndex(hasselblad).get("raw").status, "paired");
  const duplicate = [...pair(), { ...pair()[0], id: "other", folders: ["another-trip"] }];
  assert.equal(buildCaptureIndex(duplicate).get("jpg").status, "uncertain");
  assert.equal(planCaptureReview(duplicate, [{ id: "jpg", reviewState: "selected" }])[0].result.review.members.length, 1);
  const differentFolders = pair(); differentFolders[1].folders = ["another-trip"];
  assert.equal(buildCaptureIndex(differentFolders).get("jpg").status, "uncertain");
  assert.equal(planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }], { syncPairs: false })[0].result.review.members.length, 1);
  assert.throws(() => planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }, { id: "raw", reviewState: "rejected" }]), /相反/);
  assert.throws(() => planCaptureReview(pair(), [{ id: "jpg", reviewState: "unknown" }]), /Unsupported/);
});

test("paired decisions preserve human tags, stars, folders and checkpoint each member", async () => {
  const { api, saves, byId } = fakeApi(pair());
  const entry = planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }])[0];
  const checkpoints = [];
  assert.equal((await applyReviewUnit(api, entry, { libraryPath: "library", checkpoint: async (saved) => checkpoints.push(structuredClone(saved)) })).status, "succeeded");
  assert.deepEqual(saves, ["jpg", "raw"]);
  assert.deepEqual(checkpoints.map((saved) => saved.result.review.appliedIds.length), [1, 2]);
  assert.deepEqual(byId.get("jpg").tags, ["人工", "AI精选"]);
  assert.deepEqual(byId.get("raw").tags, ["人工RAW", "AI原片", "AI精选"]);
  assert.equal(byId.get("raw").star, 2);
  assert.deepEqual(byId.get("raw").folders, ["trip"]);
});

test("partial failure retries only unfinished members, including crash before checkpoint", async () => {
  let failRaw = true;
  const { api, saves } = fakeApi(pair(), (id) => id === "raw" && failRaw);
  const entry = planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }])[0];
  const before = structuredClone(entry);
  await assert.rejects(applyReviewUnit(api, entry, { libraryPath: "library" }), /save failed/);
  failRaw = false;
  // Replaying the old checkpoint sees that JPG already has the target label,
  // even though its modifiedAt changed during the successful write.
  await applyReviewUnit(api, before, { libraryPath: "library" });
  assert.deepEqual(saves, ["jpg", "raw"]);
});

test("missing or changed mate prevents the first write; library switches stop writes", async () => {
  const entry = planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }])[0];
  for (const missing of [true, false]) {
    const { api, saves, byId } = fakeApi(pair());
    if (missing) byId.delete("raw"); else byId.get("raw").modifiedAt = 2;
    assert.equal((await applyReviewUnit(api, structuredClone(entry), { libraryPath: "library" })).status, "skipped");
    assert.deepEqual(saves, []);
  }
  const { api, saves } = fakeApi(pair()); api.library.path = "other";
  await assert.rejects(applyReviewUnit(api, entry, { libraryPath: "library" }), /资源库/);
  assert.deepEqual(saves, []);
});

test("durability failure is fatal and never retries a successful label write", async () => {
  const { api, saves } = fakeApi(pair());
  const entries = planCaptureReview(pair(), [{ id: "jpg", reviewState: "selected" }]);
  await assert.rejects(runBoundedQueue({ items: entries, concurrency: 1, process: (entry) => applyReviewUnit(api, entry, {
    libraryPath: "library", checkpoint: async () => { throw new Error("disk full"); },
  }) }), /disk full/);
  assert.deepEqual(saves, ["jpg"]);
});

test("RAW counterpart of a group representative receives the same recommendation", () => {
  const items = pair();
  const group = { groupId: "phash-1", size: 2, representativeId: "jpg", items };
  const records = buildReviewSections(items, [group])[0].records;
  assert.deepEqual(records.map((record) => record.recommendation), ["selected", "selected"]);
  assert.ok(records.find((record) => record.id === "raw").reasons.some((reason) => reason.includes("留存结论一致")));
});
