import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyzeFocus, focusMetrics, mapProxyBoxToNative, parseMakerFocus } from "../src/core/focus.js";

test("maps normalized proxy boxes to native pixels", () => {
  assert.deepEqual(mapProxyBoxToNative([.1, .2, .5, .6], { width: 1000, height: 500 }),
    { left: 100, top: 100, width: 400, height: 200, box: [.1, .2, .5, .6] });
});

test("parses maker note focus tags without guessing missing points", () => {
  assert.deepEqual(parseMakerFocus({ FocusLocation: "7008 4672 4664 2336", FocusFrameSize: "745 594", AFAreaMode: "Wide" }),
    { point: [4664, 2336], coordinateSize: [7008, 4672], frameSize: [745, 594], mode: "Wide", source: "FocusLocation" });
  assert.equal(parseMakerFocus({ AFAreaMode: "Auto" }).point, null);
});

test("FocusLocation maps horizontal and 90/270 degree frames", async () => {
  const face = { box: [.3, .3, .7, .7], eyes: [[.4, .4, .5, .5]] };
  const image = await sharp({ create: { width: 100, height: 60, channels: 3, background: "white" } }).jpeg().toBuffer();
  const base = { faces: [face], makerFocus: { point: [50, 30],
    coordinateSize: [100, 60], frameSize: [20, 20], source: "FocusLocation" } };
  const horizontal = await analyzeFocus({ ...base, nativeBuffer: image,
    nativeSize: { width: 100, height: 60, orientation: 1, rawWidth: 100, rawHeight: 60 } });
  assert.deepEqual(horizontal.afPoint, [.5, .5]);
  const vertical = await sharp(image).rotate(90).toBuffer();
  const cw = await analyzeFocus({ ...base, nativeBuffer: vertical,
    nativeSize: { width: 60, height: 100, orientation: 6, rawWidth: 100, rawHeight: 60 } });
  const ccw = await analyzeFocus({ ...base, nativeBuffer: await sharp(image).rotate(-90).toBuffer(),
    nativeSize: { width: 60, height: 100, orientation: 8, rawWidth: 100, rawHeight: 60 } });
  assert.deepEqual(cw.afPoint, [.5, .5]);
  assert.deepEqual(ccw.afPoint, [.5, .5]);
});

test("FocusLocation boundary point and frame use source dimensions", async () => {
  const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).jpeg().toBuffer();
  const result = await analyzeFocus({ nativeBuffer: image,
    nativeSize: { width: 20, height: 10, orientation: 1, rawWidth: 20, rawHeight: 10 },
    faces: [{ box: [0, 0, 1, 1], eyes: [[.8, .8, 1, 1]] }],
    makerFocus: { point: [20, 10], coordinateSize: [20, 10], frameSize: [2, 2], source: "FocusLocation" } });
  assert.deepEqual(result.afPoint, [1, 1]);
  assert.equal(result.afPointOnSubject, true);
});

test("native focus metrics and eye ROIs are returned", async () => {
  const w = 200, h = 120;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = (x % 8 < 4) === (y % 8 < 4) ? 255 : 0;
    raw[(y * w + x) * 3] = raw[(y * w + x) * 3 + 1] = raw[(y * w + x) * 3 + 2] = v;
  }
  const image = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  const metrics = await focusMetrics(image);
  assert.ok(metrics.laplacianVariance > 0);
  const result = await analyzeFocus({ nativeBuffer: image,
    faces: [{ box: [.2, .1, .8, .9], eyes: [[.3, .3, .45, .5], [.55, .3, .7, .5]] }],
    makerFocus: { point: [0, 0], source: "FocusLocation" } });
  assert.equal(result.status, "ok");
  assert.equal(result.faces[0].eyes.length, 2);
  assert.equal(result.afPointOnEye, false);
});
