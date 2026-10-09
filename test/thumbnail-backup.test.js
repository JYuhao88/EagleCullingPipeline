import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ThumbnailBackupStore } from "../src/thumbnail-backup.js";
import { restoreBackupThumbnail } from "../src/plugin/fast-restore.js";
import { createAnalysisServer } from "../src/server.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-clean-backup-"));
  const sourcePath = path.join(root, "thumbnail.png");
  await sharp({ create: { width: 120, height: 80, channels: 3, background: "#456789" } }).png().toFile(sourcePath);
  return { root, sourcePath };
}

test("backup is byte-identical, immutable, isolated by library and concurrent capture safe", async () => {
  const { root, sourcePath } = await fixture();
  const original = await readFile(sourcePath);
  const store = new ThumbnailBackupStore(path.join(root, "backups"));
  const options = { libraryPath: "library-a", itemId: "one", sourcePath, allowCapture: true };
  const [a, b] = await Promise.all([store.prepare(options), store.prepare(options)]);
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(await readFile(a.outputPath), original);
  assert.equal(await store.get("library-b", "one"), null);
  await writeFile(sourcePath, "modified source");
  const reused = await store.prepare({ ...options, allowCapture: false });
  assert.equal(reused.sha256, a.sha256);
  assert.deepEqual(await readFile(reused.outputPath), original);
  await writeFile(a.outputPath, "corrupt backup");
  await assert.rejects(store.get("library-a", "one"), /校验失败/);
});

test("legacy uncertainty and RAW sources never get captured as clean backups", async () => {
  const { root, sourcePath } = await fixture();
  const store = new ThumbnailBackupStore(path.join(root, "backups"));
  await assert.rejects(store.prepare({ libraryPath: "a", itemId: "one", sourcePath, allowCapture: false }), /历史角标/);
  await assert.rejects(store.prepare({ libraryPath: "a", itemId: "one", sourcePath: "original.arw", allowCapture: true }), /RAW/);
  assert.equal(await store.get("a", "one"), null);
});

test("fast restore only writes the thumbnail and never rebuilds or mutates human metadata", async () => {
  let writes = 0;
  const item = { tags: ["人工标签"], star: 4, folders: ["folder"], width: 6000, height: 4000,
    async refreshThumbnail() { throw new Error("must not rebuild"); },
    async save() { throw new Error("must not save metadata"); },
    async setCustomThumbnail(output) { assert.equal(output, "clean.png"); writes += 1; return true; },
  };
  assert.equal((await restoreBackupThumbnail(item, null)).status, "skipped");
  assert.equal(writes, 0);
  await restoreBackupThumbnail(item, { outputPath: "clean.png", sha256: "hash" });
  assert.equal(writes, 1);
  assert.deepEqual(item.tags, ["人工标签"]);
  assert.equal(item.star, 4);
  assert.deepEqual(item.folders, ["folder"]);
  assert.equal(item.width, 6000);
  await assert.rejects(restoreBackupThumbnail({ async setCustomThumbnail() { return false; } }, { outputPath: "clean.png" }), /拒绝/);
});

test("service backup/generate/fingerprint/restore roundtrip protects manually changed thumbnails", async (t) => {
  const { root, sourcePath } = await fixture();
  const original = await readFile(sourcePath);
  const service = createAnalysisServer({ port: 0, taskStorePath: path.join(root, "tasks.json"), thumbnailBackupRoot: path.join(root, "backups") });
  await service.listen();
  t.after(() => service.server.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function post(endpoint, body) {
    const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const identity = { libraryPath: "a", itemId: "one" };
  const { backup } = await post("/thumbnail-backup", { ...identity, sourcePath, allowCapture: true });
  const badge = await post("/badge-thumbnail", { sourcePath: backup.outputPath, outputPath: path.join(root, "badge.png"), tags: ["AI候选"] });
  // Simulate the API copying the generated thumbnail into Eagle's cache.
  await writeFile(sourcePath, await readFile(badge.outputPath));
  const fingerprint = await post("/thumbnail-fingerprint", { sourcePath });
  const restored = await post("/thumbnail-backup/read", { ...identity, sourcePath, badgeSha256: fingerprint.sha256 });
  assert.deepEqual(await readFile(restored.backup.outputPath), original);
  await writeFile(sourcePath, original); // User replaces the thumbnail independently.
  const protectedResult = await post("/thumbnail-backup/read", { ...identity, sourcePath, badgeSha256: fingerprint.sha256 });
  assert.equal(protectedResult.backup, null);
  assert.match(protectedResult.reason, /人工修改/);
  assert.equal((await post("/thumbnail-backup/read", { libraryPath: "other", itemId: "one", sourcePath, badgeSha256: (await post("/thumbnail-fingerprint", { sourcePath })).sha256 })).backup, null);
});
