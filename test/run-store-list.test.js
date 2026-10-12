import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../src/server/run-store.js";

async function writeRun(root, run, mtime) {
  const dir = path.join(root, run.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "run.json");
  await writeFile(file, JSON.stringify(run));
  if (mtime) await utimes(file, mtime, mtime);
}

test("legacy runs without startedAt use run.json time and sort consistently in both lists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-store-list-"));
  try {
    await writeRun(root, { id: "run-old", status: "completed" }, new Date("2026-01-01T00:00:00Z"));
    await writeRun(root, { id: "run-new", status: "completed", startedAt: "2026-03-01T00:00:00Z" });
    await writeRun(root, { id: "run-legacy-newest", status: "completed" }, new Date("2026-05-01T00:00:00Z"));
    const store = new RunStore(root);
    const listed = (await store.list({ limit: 10 })).runs;
    assert.deepEqual(listed.map(run => run.id), ["run-legacy-newest", "run-new", "run-old"]);
    assert.equal(listed[2].startedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual((await store.recentRuns()).map(run => run.id), listed.map(run => run.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});
