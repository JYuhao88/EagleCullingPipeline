import crypto from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyModels({ root = process.cwd(), manifestPath = path.join(root, "python_worker", "model-manifest.json") } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const results = [];
  for (const model of manifest.models) {
    const filePath = path.resolve(root, model.path);
    if (!existsSync(filePath)) { results.push({ ...model, filePath, ok: false, error: "missing" }); continue; }
    const actual = await sha256(filePath);
    results.push({ ...model, filePath, ok: actual === model.sha256, actualSha256: actual });
  }
  return results;
}

