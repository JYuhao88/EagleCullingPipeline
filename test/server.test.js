import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisServer } from "../src/server.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

test("local analysis service exposes health and analyzes bounded batches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-server-"));
  const dir = path.join(root, "one.info");
  await mkdir(dir);
  const filePath = path.join(dir, "one.png");
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toFile(filePath);
  const service = createAnalysisServer({ port: 0 });
  await service.listen();
  t.after(() => service.server.close());
  const port = service.server.address().port;
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true, service: "eagle-culling" });
  const response = await fetch(`http://127.0.0.1:${port}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: "one", name: "one", filePath }] }) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.groups.length, 1);
});

test("local service creates a labeled custom thumbnail without changing the source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-badge-"));
  const sourcePath = path.join(root, "source.png");
  const outputPath = path.join(root, "badge.png");
  await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 60, g: 80, b: 100 } } }).png().toFile(sourcePath);
  const service = createAnalysisServer({ port: 0 });
  await service.listen();
  t.after(() => service.server.close());
  const port = service.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/badge-thumbnail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath, outputPath, tags: ["AI精选", "AI过曝"] }) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.skipped, false);
  const outputMetadata = await sharp(outputPath).metadata();
  const sourceMetadata = await sharp(sourcePath).metadata();
  assert.equal(outputMetadata.format, "png");
  assert.equal(sourceMetadata.width, 120);
  assert.equal(sourceMetadata.height, 80);
});
