import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyModels } from "../src/models.js";

test("model manifest verification detects missing local weights", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-models-"));
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ models: [{ name: "missing", path: "models/missing.onnx", sha256: "0" }] }));
  const [result] = await verifyModels({ root, manifestPath });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing");
});

