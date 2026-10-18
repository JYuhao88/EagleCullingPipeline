import test from "node:test";
import assert from "node:assert/strict";
import { resolveBase } from "../src/plugin/api.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { RunStore } from "../src/server/run-store.js";
import { createRunsRouter } from "../src/server/runs-routes.js";

test("base resolution prefers Eagle service health over static page origin", async () => {
  const calls = [];
  const base = await resolveBase({
    locationRef: { protocol: "http:", origin: "http://static:43128" },
    storage: { getItem: () => "http://saved:43125" },
    fetchImpl: async url => {
      calls.push(url);
      return { ok: true, json: async () => ({ service: "eagle-culling" }) };
    }
  });
  assert.equal(base, "http://static:43128");
  assert.deepEqual(calls, ["http://static:43128/health"]);
});

test("detail route generates and caches a 2048-bound JPEG", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-detail-"));
  const source = path.join(root, "source.png");
  await sharp({ create: { width: 2600, height: 1200, channels: 3, background: "#336699" } })
    .png().toFile(source);
  const store = new RunStore(path.join(root, "runs"));
  const run = { id: "run-detail", status: "completed" };
  await store.save(run, {
    run,
    units: [{ id: "unit:a", primaryItemId: "a" }],
    results: [{ unitId: "unit:a", previewPath: path.join(root, "preview.png") }],
    groups: [],
    items: [{ id: "a", filePath: source }]
  });
  await sharp({ create: { width: 800, height: 400, channels: 3, background: "#cc3311" } })
    .png().toFile(path.join(root, "preview.png"));
  const route = createRunsRouter({ store, pipeline: {} });
  let body;
  const response = { writeHead: (status, headers) => { response.status = status; response.headers = headers; },
    end: value => { body = value; } };
  await route({ method: "GET", url: "/runs/run-detail/detail/unit%3Aa" }, response,
    new URL("http://localhost/runs/run-detail/detail/unit%3Aa"));
  assert.equal(response.status, 200);
  const metadata = await sharp(body).metadata();
  assert.equal(Math.max(metadata.width, metadata.height), 2048);
});
