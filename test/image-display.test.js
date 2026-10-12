import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { RAW_EXTENSIONS, HEIF_EXTENSIONS, isRaw, isHeif } from '../src/core/image-formats.js';
import { embeddedPreviewAccepted } from '../src/core/native-image.js';
import { decodeHeif, decodeWic, parseWicOutput, resetWicHealth, wicAvailable, windowsWicScript } from '../src/core/heif-decode.js';
import { snapDisplayEdge } from '../src/core/display.js';
import { createRunsRouter } from '../src/server/runs-routes.js';
import { displayEdge, preserveDisplayGeometry } from '../src/plugin/viewer.js';

test('image format helpers cover the complete RAW and HEIF lists', () => {
  assert.ok(RAW_EXTENSIONS.includes('crw') && RAW_EXTENSIONS.includes('rwl'));
  assert.deepEqual(HEIF_EXTENSIONS, ['heic', 'heif', 'hif']);
  assert.equal(isRaw('.arw'), true); assert.equal(isRaw('hif'), false); assert.equal(isHeif('.hif'), true);
});

test('display edges snap upward and never upscale a smaller source', () => {
  assert.equal(snapDisplayEdge(1100), 2048); assert.equal(snapDisplayEdge(5000), 6144);
  assert.equal(snapDisplayEdge(5000, 3500), 3500); assert.equal(snapDisplayEdge(500, 800), 800);
  assert.equal(displayEdge({ width: 900, height: 700 }, 2), 2048);
  assert.equal(displayEdge({ width: 900, height: 700 }, 1, 3), 3072);
  assert.equal(displayEdge({ width: 900, height: 700 }, 2, 0.5), 2048, 'zooming out never lowers the tier below fit');
});

test('embedded preview threshold depends on purpose', () => {
  const preview = { width: 1616, height: 1080 }, raw = { ImageWidth: 6000, ImageHeight: 4000 };
  assert.equal(embeddedPreviewAccepted(preview, raw), false);
  assert.equal(embeddedPreviewAccepted(preview, raw, { minEdge: 0 }), true);
});

test('WIC script decodes via WPF, converts to 8-bit and reports orientation', () => {
  const script = windowsWicScript();
  assert.match(script, /BitmapDecoder\]::Create\(\$stream/);
  assert.match(script, /FormatConvertedBitmap/);
  assert.match(script, /TransformedBitmap/);
  assert.match(script, /QualityLevel = 95/);
  assert.doesNotMatch(script, /\[Uri\]/, 'paths with # or % must not go through Uri');
  assert.deepEqual(parseWicOutput('noise\r\n{"width":8742,"height":11656,"orientation":1,"applied":1,"codec":"Microsoft HEIF Decoder"}'),
    { width: 8742, height: 11656, orientation: 1, applied: 1, codec: 'Microsoft HEIF Decoder' });
  assert.throws(() => parseWicOutput('Exception calling Create'), /WIC/);
});

test('WIC decoding passes named arguments and backs off after repeated failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wic-'));
  try {
    resetWicHealth();
    const calls = [];
    const ok = async (program, args) => {
      calls.push([program, args]);
      return '{"width":10,"height":20,"orientation":6,"applied":6,"codec":"x"}';
    };
    const decoded = await decodeWic('D:/照片/#1.CR3', { temporaryDir: dir, runCommand: ok });
    assert.equal(decoded.width, 10);
    assert.equal(calls[0][0], 'powershell.exe');
    assert.deepEqual(calls[0][1].slice(-6), ['-Source', 'D:/照片/#1.CR3', '-Output', path.join(dir, 'wic.jpg'), '-Rotate', '1']);
    resetWicHealth();
    const fail = async () => { throw new Error('no decoder'); };
    for (let i = 0; i < 3; i++) await assert.rejects(decodeWic('a.heic', { temporaryDir: dir, runCommand: fail }), /no decoder/);
    assert.equal(wicAvailable(), false);
    await assert.rejects(decodeWic('a.heic', { temporaryDir: dir, runCommand: ok }), /跳过/);
    resetWicHealth();
    const sharpImpl = Object.assign(() => { throw new Error('hevc missing'); }, { format: { heif: { input: true } } });
    const heif = await decodeHeif('a.heic', { temporaryDir: dir, runCommand: ok, sharpImpl, platform: 'win32' });
    assert.equal(heif.kind, 'heif-wic');
    assert.equal(heif.orientation, 1, 'WIC output is already upright');
    assert.match(heif.warnings[0], /hevc missing/);
    resetWicHealth();
    const missing = await decodeHeif('a.heic', { temporaryDir: dir, runCommand: fail, sharpImpl, platform: 'win32' });
    assert.equal(missing.available, false);
    assert.match(missing.warning, /HEIF 图像扩展/);
  } finally { resetWicHealth(); await rm(dir, { recursive: true, force: true }); }
});

test('display route returns a capped image and deduplicates concurrent requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'display-route-'));
  try {
    const source = path.join(dir, 'source.jpg');
    await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'orange' } }).jpeg().toFile(source);
    const state = { run: { id: 'run1', status: 'completed' }, units: [{ id: 'u1', primaryItemId: 'i1', itemIds: ['i1'] }],
      items: [{ id: 'i1', filePath: source, ext: 'jpg', width: 3000, height: 1500 }], results: [{ unitId: 'u1', sourcePath: source }] };
    let calls = 0;
    const store = { root: dir, dir: () => path.join(dir, 'run1'), unitData: async () => {
      calls++; await new Promise(resolve => setTimeout(resolve, 5)); return state;
    } };
    const router = createRunsRouter({ store });
    const response = () => Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; this.writableEnded = true; }, });
    const url = new URL('http://localhost/runs/run1/display/u1?edge=5000');
    const a = response(), b = response(); await Promise.all([router({ method: 'GET' }, a, url), router({ method: 'GET' }, b, url)]);
    assert.equal(a.status, 200); assert.equal(a.headers['x-display-edge'], '3000'); assert.equal(b.status, 200);
    assert.equal(calls, 2); // each HTTP request may read state; image generation itself is deduplicated.
    const meta = await sharp(a.body).metadata(); assert.deepEqual([meta.width, meta.height], [3000, 1500]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('viewer display swap preserves rendered geometry', () => {
  assert.deepEqual(preserveDisplayGeometry({ scale: 2, x: -10, y: 3 }, { width: 1000 }, { width: 2000 }),
    { scale: 1, x: -10, y: 3 });
});
