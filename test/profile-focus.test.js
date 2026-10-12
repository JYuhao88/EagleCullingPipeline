import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { instrument, differences } from '../scripts/profile-focus.mjs';
import { analyzeFocus } from '../src/core/focus.js';

// Verify that profiling A measures the actual production calculation, including orientation.
// Verify that omitting both JPEG round trips is rejected, even when statuses remain identical.
test('focus profiling preserves baseline and exposes lossy round-trip differences for all orientations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'focus-profile-test-'));
  const a = await instrument('A', directory), b = await instrument('B', directory);
  try {
    const { analyzeFocus: profiled } = await import(a.focusFile);
    const { analyzeFocus: candidate } = await import(b.focusFile);
    const { withNativeImage } = await import(a.nativeFile);
    const pixels = Buffer.alloc(128 * 96 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + Math.floor(i / 37)) % 256;
    for (let orientation = 1; orientation <= 8; orientation++) {
      const file = path.join(directory, `${orientation}.jpg`);
      await sharp(pixels, { raw: { width: 128, height: 96, channels: 3 } })
        .withMetadata({ orientation }).jpeg({ quality: 93 }).toFile(file);
      await withNativeImage({ filePath: file, ext: 'jpg' }, {}, async ({ image, source }) => {
        const nativeSize = { width: source.width, height: source.height, orientation: source.orientation,
          rawWidth: source.rawWidth, rawHeight: source.rawHeight };
        const faces = [{ box: [.1, .1, .9, .9] }];
        const nativeBuffer = await image().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
        const options = { nativeBuffer, nativeSize, faces };
        const baseline = await analyzeFocus(options);
        assert.deepEqual(await profiled(options), baseline, `instrumentation orientation ${orientation}`);
        const raw = await image().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        const expectedPixels = await sharp(file).rotate().removeAlpha().toColourspace('srgb')
          .raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual(raw, expectedPixels, `raw orientation ${orientation}`);
        raw.info = { width: raw.info.width, height: raw.info.height, channels: raw.info.channels };
        const experimental = await candidate({ ...options, nativeBuffer: raw });
        assert.equal(experimental.status, baseline.status);
        assert.equal(experimental.naReason, baseline.naReason);
        assert.notDeepEqual(experimental, baseline, `reject lossy omission orientation ${orientation}`);
        assert.ok(differences(baseline, experimental).some(row => row.field.includes('laplacianVariance')));
      });
    }
  } finally {
    for (const file of [a.focusFile, a.nativeFile, b.focusFile, b.nativeFile]) await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
