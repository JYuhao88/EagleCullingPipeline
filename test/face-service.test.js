import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import sharp from "sharp";
import { faceCropBox } from "../src/server/face-image.js";
import { createRunsRouter } from "../src/server/runs-routes.js";
import { RunStore } from "../src/server/run-store.js";

test("face crop expands each edge by 35% and clips to image bounds", () => {
  assert.deepEqual(faceCropBox([0.3, 0.3, 0.7, 0.7], 100, 100), { left: 16, top: 16, width: 68, height: 68 });
  assert.deepEqual(faceCropBox([0, 0, 0.2, 0.2], 100, 200), { left: 0, top: 0, width: 27, height: 54 });
  assert.deepEqual(faceCropBox([0.8, 0.8, 1, 1], 100, 200), { left: 73, top: 146, width: 27, height: 54 });
  assert.deepEqual(faceCropBox([0, 0, 1, 1], 100, 200), { left: 0, top: 0, width: 100, height: 200 });
  assert.deepEqual(faceCropBox([0.5, 0.5, 0.501, 0.501], 10, 10), { left: 4, top: 4, width: 2, height: 2 });
});

test("face crop rejects absent, inverted or non-normalized boxes and invalid dimensions", () => {
  for (const box of [undefined, [], [0, 0, 1], [-0.1, 0, 1, 1], [0, 0, 1.1, 1], [0, 0, NaN, 1], [0.5, 0, 0.4, 1]]) {
    assert.equal(faceCropBox(box, 100, 100), null);
  }
  assert.equal(faceCropBox([0, 0, 1, 1], 0, 100), null);
  assert.equal(faceCropBox([0, 0, 1, 1], 100, 100, -1), null);
});

async function request(route, pathname) {
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  assert.equal(await route({ method: "GET" }, response, { pathname, searchParams: new URLSearchParams() }), true);
  return response;
}

async function fixture(t, { sourceMissing = false, faces = [{ box: [0.4, 0.3, 0.6, 0.6] }] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-face-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.png");
  const preview = path.join(root, "preview.png");
  const rectangle = await sharp({ create: { width: 240, height: 240, channels: 3, background: "#00cc00" } })
    .png().toBuffer();
  const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#0000cc" } })
    .composite([{ input: rectangle, left: 480, top: 240 }]).png().toBuffer();
  await sharp(image).toFile(preview);
  if (!sourceMissing) await sharp(image).toFile(source);
  const store = new RunStore(path.join(root, "runs"));
  const run = { id: "run-face", status: "completed" };
  await store.save(run, {
    run,
    units: [{ id: "unit:a", primaryItemId: "a" }],
    results: [{ unitId: "unit:a", previewPath: preview, ...(faces === null ? {} : { faces }) }],
    items: [{ id: "a", filePath: source }]
  });
  return { root, source, preview, store, route: createRunsRouter({ store, pipeline: {} }) };
}

test("face route crops the selected face, returns a 320-bound JPEG and reuses its run cache", async t => {
  const { store, route, source, preview } = await fixture(t);
  const response = await request(route, "/runs/run-face/face/unit%3Aa/0");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "image/jpeg");
  const metadata = await sharp(response.body).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(Math.max(metadata.width, metadata.height), 320);
  const centerImage = await sharp(response.body).extract({ left: 155, top: 155, width: 10, height: 10 }).toBuffer();
  const center = await sharp(centerImage).stats();
  assert.ok(center.channels[1].mean > 180);
  assert.ok(center.channels[0].mean < 30);
  const cached = path.join(store.dir("run-face"), "face", "unit%3Aa-0.jpg");
  assert.deepEqual(await readFile(cached), response.body);
  await Promise.all([rm(source), rm(preview), rm(path.join(store.dir("run-face"), "detail"), { recursive: true })]);
  assert.deepEqual((await request(route, "/runs/run-face/face/unit%3Aa/0")).body, response.body);
});

test("face route falls back to the proxy when the primary source cannot be decoded", async t => {
  const { route } = await fixture(t, { sourceMissing: true });
  const response = await request(route, "/runs/run-face/face/unit%3Aa/0");
  assert.equal(response.status, 200);
  assert.equal((await sharp(response.body).metadata()).width, 320);
});

test("concurrent face requests share detail generation and return valid identical cached images", async t => {
  const { route } = await fixture(t, { faces: [{ box: [0.4, 0.3, 0.6, 0.6] }, { box: [0.1, 0.1, 0.2, 0.2] }] });
  const responses = await Promise.all([0, 1, 0, 1].map(index => request(route, `/runs/run-face/face/unit%3Aa/${index}`)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal((await sharp(response.body).metadata()).format, "jpeg");
  }
  assert.deepEqual(responses[0].body, responses[2].body);
  assert.deepEqual(responses[1].body, responses[3].body);
});

test("face route returns 404 for missing faces, units, runs and malformed or unsafe IDs", async t => {
  const { route } = await fixture(t, { faces: null });
  for (const pathname of [
    "/runs/run-face/face/unit%3Aa/0", "/runs/run-face/face/unit%3Aa/1", "/runs/run-face/face/unit%3Aa/-1",
    "/runs/run-face/face/unit%3Aa/0.5",
    "/runs/run-face/face/unit%3Aa/99999999999999999999", "/runs/run-face/face/missing/0", "/runs/missing/face/unit%3Aa/0",
    "/runs/run-face/face/%2e%2e%2fsecret/0", "/runs/run-face/face/%2e%2e%5csecret/0", "/runs/run-face/face/%00/0",
    "/runs/run-face/face/%XX/0", "/runs/%2e%2e/face/unit%3Aa/0", "/runs/../face/unit%3Aa/0"
  ]) {
    assert.equal((await request(route, pathname)).status, 404, pathname);
  }
  const legacy = await fixture(t, { faces: [] });
  assert.equal((await request(legacy.route, "/runs/run-face/face/unit%3Aa/0")).status, 404);
});


test("native focus route preserves pixel dimensions and rejects unsafe IDs and unknown regions", async t => {
  const { route } = await fixture(t);
  const response = await request(route, "/runs/run-face/focus-crop/unit%3Aa/0");
  assert.equal(response.status, 200);
  const meta = await sharp(response.body).metadata();
  assert.equal(meta.width, 240);
  assert.equal(meta.height, 240);
  for (const pathname of ["/runs/run-face/focus-crop/%2e%2e%2fsecret/0", "/runs/run-face/focus-crop/unit%3Aa/-1",
    "/runs/run-face/focus-crop/missing/0", "/runs/run-face/focus-crop/unit%3Aa/99999999999999999999"]) {
    assert.equal((await request(route, pathname)).status, 404);
  }
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await route({ method: "GET" }, res, new URL("http://localhost/runs/run-face/focus-crop/unit%3Aa/0?region=eyes"));
  assert.equal(res.status, 404);
  assert.match(res.body, /eye-landmarks-unavailable/);
  await route({ method: "GET" }, res, new URL("http://localhost/runs/run-face/focus-crop/unit%3Aa/0?region=.."));
  assert.equal(res.status, 404);
});
