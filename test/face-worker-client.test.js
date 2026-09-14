import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runFaceWorker } from "../src/face-worker-client.js";

test("face worker client round-trips a real local image", async (t) => {
  const python = path.resolve(".venv/Scripts/python.exe");
  if (!existsSync(python)) { t.skip("optional Python worker environment is not installed"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-face-client-"));
  const filePath = path.join(root, "sample.jpg");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(filePath);
  const [result] = await runFaceWorker([{ id: "sample", filePath }], { python, cwd: process.cwd() });
  assert.equal(result.id, "sample");
  assert.equal(result.faceCount, 0);
});

