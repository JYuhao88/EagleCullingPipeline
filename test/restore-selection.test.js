import assert from "node:assert/strict";
import test from "node:test";
import { confirmSelectedRestore, refreshNativeThumbnail } from "../src/plugin/restore-selection.js";
import { runBoundedQueue } from "../src/plugin/task-queue.js";

test("legacy restoration uses only selected images and an explicit warning", async () => {
  const photo = { id: "old", name: "旧角标", ext: "3fr" };
  const api = { item: { getSelected: async () => [photo, { id: "video", ext: "mp4" }], getAll: async () => { throw new Error("must not scan all"); } } };
  let warning = "";
  const result = await confirmSelectedRestore(api, (message) => { warning = message; return true; });
  assert.deepEqual(result, [photo]);
  assert.ok(warning.includes("人工自定义缩略图"));
  assert.ok(warning.includes("1 张"));
});

test("cancelling legacy restoration yields no work", async () => {
  const api = { item: { getSelected: async () => [{ id: "one", ext: "jpg" }] } };
  assert.deepEqual(await confirmSelectedRestore(api, () => false), []);
});

test("empty selection cannot restore, but 8,000 selected images are accepted", async () => {
  await assert.rejects(confirmSelectedRestore({ item: { getSelected: async () => [] } }, () => true), /选择/);
  const result = await confirmSelectedRestore({ item: { getSelected: async () => Array.from({ length: 8000 }, (_, id) => ({ id, ext: "jpg" })) } }, () => true);
  assert.equal(result.length, 8000);
});

test("native restore calls only refreshThumbnail and preserves human metadata", async () => {
  let called = 0;
  const item = { tags: ["人工", "AI精选"], star: 4, folders: ["folder"], refreshThumbnail: async () => { called += 1; return true; } };
  await refreshNativeThumbnail(item);
  assert.equal(called, 1);
  assert.deepEqual(item.tags, ["人工", "AI精选"]);
  assert.equal(item.star, 4);
  assert.deepEqual(item.folders, ["folder"]);
});

test("false Eagle restore results are failures and retry through the task queue", async () => {
  let called = 0;
  const item = { refreshThumbnail: async () => { called += 1; return called >= 2; } };
  const result = await runBoundedQueue({ items: [item], delayMs: 0, process: refreshNativeThumbnail });
  assert.equal(called, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].attempts, 2);
  await assert.rejects(refreshNativeThumbnail({ refreshThumbnail: async () => false }), /失败/);
});
