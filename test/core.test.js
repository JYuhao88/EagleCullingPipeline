import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateDecision, CONTRACT_VERSION } from "../src/core/contracts.js";
import { ResultsStore } from "../src/core/results-store.js";
import { AnalysisPipeline } from "../src/core/pipeline.js";
import { createAnalysisServer } from "../src/server.js";
import { RunStore } from "../src/server/run-store.js";
import { score, SCORER_CACHE_KEY } from "../src/core/scorer.js";
import { scoreLabels } from "../scripts/spot-check-score.mjs";
test("contracts validate v1 decision", () => {
  assert.equal(
    validateDecision({
      contractVersion: CONTRACT_VERSION,
      id: "x",
      action: "selected",
    }),
    true,
  );
  assert.equal(validateDecision({ id: "x", action: "selected" }), false);
});
test("results store resumes by fingerprint", async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), "eagle-cache-")),
    s = new ResultsStore(d);
  await s.put("f", { id: "x" });
  const s2 = new ResultsStore(d);
  assert.deepEqual(await s2.get("f"), { id: "x" });
});

test("missing scorer model returns unavailable quality", async () => {
  const results = await score(["/no/such/preview.jpg"], {
    root: await mkdtemp(path.join(os.tmpdir(), "eagle-no-model-")),
  });
  assert.equal(results[0].quality, null);
  assert.equal(results[0].calibrated, false);
  assert.equal(results[0].model, "unavailable");
  assert.match(results[0].warning, /模型校验失败/);
});

test("scorer model and version are part of the cache fingerprint", () => {
  assert.match(`file:analysis-v3:${SCORER_CACHE_KEY}`, /topiq-nr-onnx:topiq-nr-512-v1/);
});

test("spot-check scoring reports top-1 and pairwise agreement", () => {
  const report = scoreLabels({
    run: { id: "run-x" },
    results: [],
    groups: [{
      id: "g1", unitIds: ["a", "b", "c"],
      ranking: [{ unitId: "a", rank: 1, score: 0.9 }, { unitId: "b", rank: 2, score: 0.7 }, { unitId: "c", rank: 3, score: 0.2 }],
    }],
  }, [{ groupId: "g1", bestUnitId: "a" }]);
  assert.equal(report.top1.rate, 1);
  assert.equal(report.pairwise.rate, 1);
});
test("spot-check scoring counts unable groups separately", () => {
  const report = scoreLabels({
    run: { id: "run-x" },
    groups: [{ id: "g1", unitIds: ["a", "b"], ranking: [
      { unitId: "a", rank: 1, score: 0.9 }, { unitId: "b", rank: 2, score: 0.7 },
    ] }],
  }, [{ groupId: "g1", bestUnitId: null }]);
  assert.equal(report.unable, 1);
  assert.equal(report.top1.total, 0);
  assert.equal(report.pairwise.total, 0);
});
test("pipeline cancellation", async () => {
  const p = new AnalysisPipeline({
    analyzer: async (r) => {
      await new Promise((x) => setTimeout(x, 20));
      return { ...r, qualityScore: 1, phash: "0" };
    },
  });
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    p.run([{ id: "x", filePath: "/none" }], { signal: c.signal }),
    /cancelled|aborted/,
  );
});
async function seedRun(root) {
  const runStore = new RunStore(root);
  const run = { contractVersion: 1, id: "run-test", status: "completed", libraryPath: "/lib/a.library" };
  await runStore.save(run, {
    run,
    units: [{ contractVersion: 1, id: "unit:a", primaryItemId: "a", itemIds: ["a", "a-raw"] }],
    results: [{ contractVersion: 1, unitId: "unit:a", flags: ["blurry"], metrics: {}, score: 0.4 }],
    groups: [{
      contractVersion: 1,
      id: "group:unit:a",
      unitIds: ["unit:a"],
      ranking: [{ unitId: "unit:a", rank: 1, score: 0.4, reasons: ["可能模糊"] }],
      suggested: { "unit:a": "selected" },
    }],
    items: [{ id: "a", ext: "jpg", tags: [] }, { id: "a-raw", ext: "arw", tags: [] }],
  });
  return runStore;
}

function fakeEagle(libraryPath, tags) {
  const updates = [];
  return {
    updates,
    assertLibrary: async (expected) => {
      if (expected !== libraryPath) throw new Error("Eagle library mismatch");
    },
    itemInfo: async (id) => ({ id, tags: [...(tags[id] || [])], star: 5 }),
    updateItem: async (item) => {
      updates.push(item);
      tags[item.id] = item.tags;
    },
  };
}

test("server review flow keeps live manual tags, follows RAW and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-runs-"));
  const runStore = await seedRun(root);
  const api = fakeEagle("/lib/a.library", { a: ["手工后加"], "a-raw": [] });
  const s = createAnalysisServer({ port: 0, runStore, api });
  await s.listen();
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const post = (url, body) => fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const preflight = await fetch(`${base}/runs`, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/);
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
    await post("/runs/run-test/decisions", {
      decisions: [{ unitId: "unit:a", action: "rejected", flags: [], source: "human" }],
    });
    const preview = await post("/runs/run-test/apply", {});
    assert.equal(preview.dryRun, true);
    assert.equal(api.updates.length, 0);
    await post("/runs/run-test/apply", { apply: true });
    const byId = Object.fromEntries(api.updates.map((item) => [item.id, item.tags]));
    assert.deepEqual(byId.a, ["手工后加", "AI淘汰", "AI模糊"]);
    assert.deepEqual(byId["a-raw"], ["AI淘汰", "AI模糊"]);
    const again = await post("/runs/run-test/apply", { apply: true });
    assert.equal(api.updates.length, 2);
    assert.equal(again.summary.unchanged, 2);
  } finally {
    await s.close();
  }
});
import { restoreThumbnails } from "../src/core/restore-thumbnails.js";
test("restore thumbnails uses fake Eagle API and dry-run is side-effect free", async () => {
  const calls = [];
  const api = {
    refreshThumbnail: async (id) => {
      calls.push(id);
    },
  };
  assert.deepEqual(await restoreThumbnails(api, ["a", "b"]), [
    { id: "a", dryRun: true },
    { id: "b", dryRun: true },
  ]);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await restoreThumbnails(api, ["a"], {
      apply: true,
      confirm: "RESTORE_THUMBNAILS",
    }),
    [{ id: "a", ok: true }],
  );
  assert.deepEqual(calls, ["a"]);
});
test("apply refuses to write when Eagle has a different library open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-runs-"));
  const runStore = await seedRun(root);
  const api = fakeEagle("/lib/other.library", { a: [], "a-raw": [] });
  const s = createAnalysisServer({ port: 0, runStore, api });
  await s.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${s.server.address().port}/runs/run-test/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: true }),
    });
    assert.equal(response.status, 400);
    assert.equal(api.updates.length, 0);
  } finally {
    await s.close();
  }
});
