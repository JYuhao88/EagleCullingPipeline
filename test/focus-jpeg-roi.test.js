import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { alignedJpegRect, alignedNativeJpegRoi, alignedFocusJpegRoi } from '../src/core/focus-jpeg-roi.js';

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
  for (const [width, height] of [[127, 93], [128, 96], [17, 19], [7, 5]]) {
    const data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = state >>> 24;
    }
    for (let orientation = 1; orientation <= 8; orientation++) {
      const input = await sharp(data, { raw: { width, height, channels: 3 } })
        .withMetadata({ orientation }).jpeg({ quality: 93 }).toBuffer();
      const swapped = orientation >= 5;
      const size = { width: swapped ? height : width, height: swapped ? width : height };
      const image = () => {
        let pipeline = sharp(input);
        if ([2, 4, 5, 7].includes(orientation)) pipeline = pipeline.flop();
        return pipeline.rotate(({ 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 })[orientation] || 0);
      };
      const full = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
      const rois = [{ left: 0, top: 0, ...size },
        { left: 1, top: 1, width: Math.min(9, size.width - 1), height: Math.min(11, size.height - 1) },
        { left: size.width - 3, top: size.height - 3, width: 3, height: 3 },
        { left: 0, top: 2, width: Math.min(5, size.width), height: size.height - 2 }];
      for (let i = 0; i < 12; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const left = state % size.width;
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const top = state % size.height;
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const rw = 1 + state % (size.width - left);
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        rois.push({ left, top, width: rw, height: 1 + state % (size.height - top) });
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
  const { analyzeFocus, analyzeFocusFromNativeImage } = await import('../src/core/focus.js');
  const pixels = Buffer.alloc(97 * 71 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 71 + Math.floor(i / 11)) % 256;
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (const format of ['jpeg', 'png']) {
      const input = await sharp(pixels, { raw: { width: 97, height: 71, channels: 3 } })
        .withMetadata({ orientation }).toFormat(format).toBuffer();
      const image = () => {
        let pipeline = sharp(input);
        if ([2, 4, 5, 7].includes(orientation)) pipeline = pipeline.flop();
        return pipeline.rotate(({ 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 })[orientation] || 0);
      };
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
