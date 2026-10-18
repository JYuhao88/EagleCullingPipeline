import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { analyzeFocus, analyzeFocusFromNativeImage, focusMetrics, mapProxyBoxToNative,
  parseMakerFocus } from '../src/core/focus.js';
import { alignedJpegRect, alignedNativeJpegRoi, alignedFocusJpegRoi } from '../src/core/focus-jpeg-roi.js';

const orient = (input, orientation) => () => {
  let pipeline = sharp(input);
  if ([2, 4, 5, 7].includes(orientation)) pipeline = pipeline.flop();
  return pipeline.rotate(({ 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 })[orientation] || 0);
};

test('maps normalized proxy boxes to native pixels', () => {
  assert.deepEqual(mapProxyBoxToNative([.1, .2, .5, .6], { width: 1000, height: 500 }),
    { left: 100, top: 100, width: 400, height: 200, box: [.1, .2, .5, .6] });
});

test('parses maker note focus tags without guessing missing points', () => {
  assert.deepEqual(parseMakerFocus({ FocusLocation: '7008 4672 4664 2336', FocusFrameSize: '745 594', AFAreaMode: 'Wide' }),
    { point: [4664, 2336], coordinateSize: [7008, 4672], frameSize: [745, 594], mode: 'Wide', source: 'FocusLocation' });
  assert.equal(parseMakerFocus({ AFAreaMode: 'Auto' }).point, null);
});

test('FocusLocation maps horizontal, 90/270 degree and boundary frames using source dimensions', async () => {
  const image = await sharp({ create: { width: 100, height: 60, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const faces = [{ box: [.3, .3, .7, .7], eyes: [[.4, .4, .5, .5]] }];
  const center = { point: [50, 30], coordinateSize: [100, 60], frameSize: [20, 20], source: 'FocusLocation' };
  const raw = { rawWidth: 100, rawHeight: 60 };
  for (const [label, nativeBuffer, nativeSize, options, afPoint, onSubject] of [
    ['horizontal', image, { width: 100, height: 60, orientation: 1, ...raw }, { faces, makerFocus: center }, [.5, .5]],
    ['cw', await sharp(image).rotate(90).toBuffer(), { width: 60, height: 100, orientation: 6, ...raw },
      { faces, makerFocus: center }, [.5, .5]],
    ['ccw', await sharp(image).rotate(-90).toBuffer(), { width: 60, height: 100, orientation: 8, ...raw },
      { faces, makerFocus: center }, [.5, .5]],
    ['boundary', small, { width: 20, height: 10, orientation: 1, rawWidth: 20, rawHeight: 10 },
      { faces: [{ box: [0, 0, 1, 1], eyes: [[.8, .8, 1, 1]] }],
        makerFocus: { point: [20, 10], coordinateSize: [20, 10], frameSize: [2, 2], source: 'FocusLocation' } }, [1, 1], true],
  ]) {
    const result = await analyzeFocus({ nativeBuffer, nativeSize, ...options });
    assert.deepEqual(result.afPoint, afPoint, label);
    if (onSubject !== undefined) assert.equal(result.afPointOnSubject, onSubject, label);
  }
});

test('native focus metrics and eye ROIs are returned', async () => {
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
    makerFocus: { point: [0, 0], source: 'FocusLocation' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.faces[0].eyes.length, 2);
  assert.equal(result.afPointOnEye, false);
});

test('q96 4:4:4 defaults disable cross-block encoder options', () => {
  const options = sharp().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).options;
  assert.equal(options.jpegQuality, 96);
  assert.equal(options.jpegChromaSubsampling, '4:4:4');
  for (const key of ['jpegProgressive', 'jpegTrellisQuantisation', 'jpegOvershootDeringing', 'jpegOptimiseScans'])
    assert.equal(options[key], false, key);
  assert.equal(options.jpegOptimiseCoding, true);
  assert.equal(options.jpegQuantisationTable, 0);
});

test('aligned q96 JPEG ROI matches full-frame JPEG pixels for odd sizes, edges and all orientations', async () => {
  let state = 42;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (const [width, height] of [[127, 93], [7, 5]]) {
    const data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < data.length; i++) data[i] = next() >>> 24;
    for (let orientation = 1; orientation <= 8; orientation++) {
      const input = await sharp(data, { raw: { width, height, channels: 3 } })
        .withMetadata({ orientation }).jpeg({ quality: 93 }).toBuffer();
      const swapped = orientation >= 5;
      const size = { width: swapped ? height : width, height: swapped ? width : height };
      const image = orient(input, orientation);
      const full = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
      const rois = [{ left: 0, top: 0, ...size },
        { left: 1, top: 1, width: Math.min(9, size.width - 1), height: Math.min(11, size.height - 1) },
        { left: size.width - 3, top: size.height - 3, width: 3, height: 3 },
        { left: 0, top: 2, width: Math.min(5, size.width), height: size.height - 2 }];
      for (let i = 0; i < 4; i++) {
        const left = next() % size.width, top = next() % size.height;
        const rw = 1 + next() % (size.width - left);
        rois.push({ left, top, width: rw, height: 1 + next() % (size.height - top) });
      }
      for (const roi of rois) {
        const expected = await sharp(full).extract(roi).raw().toBuffer({ resolveWithObject: true });
        const actual = await alignedNativeJpegRoi(image, size, roi);
        if (roi.left === 1 && roi.top === 1) {
          const raw = await image().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
          const a = await sharp(full).rotate().extract(roi).jpeg().toBuffer();
          const b = await alignedFocusJpegRoi(raw, size, roi);
          assert.deepEqual(b, a, `focus JPEG bytes orientation ${orientation}`);
        }
        assert.deepEqual(actual, expected, JSON.stringify({ width, height, orientation, roi,
          aligned: alignedJpegRect(roi, size.width, size.height) }));
      }
    }
  }
});

test('default native focus matches the legacy full-frame round trip and unsupported-format fallback', async () => {
  const pixels = Buffer.alloc(97 * 71 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 71 + Math.floor(i / 11)) % 256;
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (const format of ['jpeg', 'png']) {
      const input = await sharp(pixels, { raw: { width: 97, height: 71, channels: 3 } })
        .withMetadata({ orientation }).toFormat(format).toBuffer();
      const image = orient(input, orientation);
      const source = { width: orientation >= 5 ? 71 : 97, height: orientation >= 5 ? 97 : 71,
        orientation, rawWidth: 97, rawHeight: 71 };
      const options = { nativeSize: source, faces: [{ box: [.1, .07, .89, .91] }, { box: [.5, .55, 1, 1] }],
        makerFocus: { point: [40, 32], coordinateSize: [97, 71], source: 'FocusLocation' } };
      const full = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
      const baseline = await analyzeFocus({ ...options, nativeBuffer: full });
      assert.deepEqual(await analyzeFocusFromNativeImage({ image, source, ...options }), baseline,
        `${format} orientation ${orientation}`);
      assert.deepEqual(await analyzeFocusFromNativeImage({ image, source, faces: [] }),
        await analyzeFocus({ nativeBuffer: full, nativeSize: source, faces: [] }));
    }
  }
});
