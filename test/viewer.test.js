import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { clampView, fitScale, visibleBox, zoomAt } from "../src/plugin/viewer.js";
import { MAX_REGION_AREA, parseRegionBox, regionCropImage } from "../src/server/focus-image.js";

const stage = { width: 1000, height: 500 };
const image = { width: 3000, height: 2000 };

test("fit scale centers the whole photo inside the stage", () => {
  const scale = fitScale(stage, image);
  assert.equal(scale, 0.25);
  assert.deepEqual(clampView({ scale, x: 99, y: -99 }, stage, image), { scale, x: 125, y: 0 });
});

test("zooming keeps the image point under the cursor fixed and clamps to the fit scale", () => {
  const start = clampView({ scale: 0.5, x: -500, y: -250 }, stage, image);
  const point = { x: 600, y: 200 };
  const before = [(point.x - start.x) / start.scale, (point.y - start.y) / start.scale];
  const next = zoomAt(start, 2, point, stage, image);
  assert.equal(next.scale, 1);
  assert.deepEqual([(point.x - next.x) / next.scale, (point.y - next.y) / next.scale], before);
  assert.equal(zoomAt(start, 0.01, point, stage, image).scale, 0.25);
  assert.equal(zoomAt(start, 1000, point, stage, image).scale, 8);
});

test("panning never exposes empty space beyond the image edges", () => {
  const view = clampView({ scale: 1, x: 500, y: -5000 }, stage, image);
  assert.deepEqual(view, { scale: 1, x: 0, y: -1500 });
});

test("visible box snaps outward and stays within the server region limit when zoomed in", () => {
  const box = visibleBox({ scale: 1, x: -1000, y: -700 }, stage, image);
  assert.deepEqual(box, [10 / 32, 11 / 32, 22 / 32, 20 / 32]);
  assert.ok(parseRegionBox(box.join(",")));
  assert.ok((box[2] - box[0]) * (box[3] - box[1]) <= MAX_REGION_AREA);
});

test("region crop returns original pixels for the requested box", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viewer-test-"));
  try {
    const file = path.join(dir, "image.jpg");
    await sharp({ create: { width: 640, height: 320, channels: 3, background: "green" } }).jpeg().toFile(file);
    const state = { units: [{ id: "u1", primaryItemId: "i1", itemIds: ["i1"] }], items: [{ id: "i1", filePath: file, ext: "jpg" }] };
    const crop = await regionCropImage({ root: dir }, "run", "u1", [0.25, 0.25, 0.75, 0.75], state);
    assert.equal(crop.available, true);
    const meta = await sharp(crop.path).metadata();
    assert.deepEqual([meta.width, meta.height], [320, 160]);
    assert.equal((await regionCropImage({ root: dir }, "run", "missing", [0, 0, 0.5, 0.5], state)).available, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("region box parser rejects malformed, inverted and oversized boxes", () => {
  assert.deepEqual(parseRegionBox("0.1,0.2,0.3,0.4"), [0.1, 0.2, 0.3, 0.4]);
  for (const value of ["", "0,0,1", "0.5,0.5,0.4,0.6", "0,0,1,1", "a,b,c,d", "-0.1,0,0.2,0.2"]) {
    assert.equal(parseRegionBox(value), null, value);
  }
});
