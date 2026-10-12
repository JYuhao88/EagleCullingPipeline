import { performanceMode, nativeChildLaunch } from './performance-mode.js';
import { exiftoolRequest, workerLimit } from './exiftool-pool.js';
import { replaceFile } from './atomic-file.js';
import { localSetting } from './local-config.js';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, stat, readFile, writeFile, readdir, utimes } from 'node:fs/promises';
import sharp from 'sharp';

const RAW = new Set(['arw', 'dng', '3fr', 'cr2', 'cr3', 'nef', 'raf', 'orf', 'rw2']);
const decoder = fileURLToPath(new URL('../../ml/raw/decode.py', import.meta.url));
const fileOf = item => item?.filePath || item?.path || item?.analysisPath;
const extension = item => String(item?.ext || path.extname(fileOf(item) || '').slice(1)).toLowerCase();
let active = 0;
let reservedBytes = 0;
const waiting = [];
const DECODE_BUDGET_BYTES = 1536 * 1024 ** 2;
export function nativeDecodeReservation(record, options = {}) {
  // Allow decoder, orientation, JPEG encoding and ROI decoding working sets.
  const pixels = [record, ...(options.pairedItems || record.pairedItems || [])]
    .map(item => Number(item.width) * Number(item.height)).filter(value => Number.isFinite(value) && value > 0);
  return pixels.length ? Math.min(DECODE_BUDGET_BYTES, Math.max(...pixels) * 16) : DECODE_BUDGET_BYTES;
}
export function nativeDecodeLimit() {
  // Full-resolution 100 MP decodes have a much larger working set than model previews.
  return Math.min(performanceMode() === 'turbo' ? 2 : Infinity, workerLimit('EAGLE_NATIVE_CONCURRENCY'));
}
// Full-resolution buffers stay bounded; two concurrent decodes are opt-in.
async function serial(fn, options = {}) {
  options.signal?.throwIfAborted();
  const bytes = options.decodeBytes || DECODE_BUDGET_BYTES;
  const budget = performanceMode() === 'turbo' ? DECODE_BUDGET_BYTES : Infinity;
  if (active >= nativeDecodeLimit() || reservedBytes + bytes > budget || (options.background && active > 0)) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, background: options.background, limit: nativeDecodeLimit(), bytes, budget };
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(options.signal.reason);
      };
      entry.resolve = () => { options.signal?.removeEventListener('abort', abort); resolve(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      waiting.push(entry);
    });
  } else { active += 1; reservedBytes += bytes; }
  try {
    options.signal?.throwIfAborted();
    if (options.isBusy?.()) return { available: false, naReason: 'analysis-busy' };
    return await fn();
  } finally {
    active -= 1;
    reservedBytes -= bytes;
    const index = waiting.findIndex(entry => !entry.background && active < entry.limit
      && reservedBytes + entry.bytes <= entry.budget);
    // Background generation must not start alongside another native decode.
    if (index >= 0 || (active === 0 && waiting.some(entry => entry.background))) {
      const nextIndex = index >= 0 ? index : waiting.findIndex(entry => entry.background);
      const next = waiting.splice(nextIndex, 1)[0];
      if (next) { active += 1; reservedBytes += next.bytes; next.resolve(); }
    }
  }
}

function command(program, args, { binary = false, timeoutMs = 60000, single = false, signal } = {}) {
  if (program === 'exiftool' && !single) return exiftoolRequest(args, {
    binary, signal, fallback: () => command(program, args, { binary, timeoutMs, single: true, signal }),
  });
  if (program === 'exiftool') {
    program = localSetting('EAGLE_EXIFTOOL', 'exiftool');
    if (process.platform === 'win32') args = ['-charset', 'filename=UTF8', ...args];
  }
  return new Promise((resolve, reject) => {
    const launch = nativeChildLaunch(program, args);
    const child = spawn(launch.command, launch.args, { windowsHide: true, signal });
    if (process.platform === 'win32') child.once('spawn', () => {
      try { os.setPriority(child.pid, performanceMode() === 'turbo' ? os.constants.priority.PRIORITY_NORMAL
      : os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch (error) { child.kill(); child.emit('error', error); }
    });
    const chunks = []; let bytes = 0; let stderr = '';
    const terminate = () => child.kill(performanceMode() === 'turbo' ? 'SIGTERM' : 'SIGKILL');
    const timer = setTimeout(terminate, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) terminate(); else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${program}: ${stderr || `exit ${code}`}`));
      else { const data = Buffer.concat(chunks); resolve(binary ? data : data.toString()); }
    });
  });
}

export function normalizedRect(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    || box[2] <= box[0] || box[3] <= box[1]) return null;
  const left = Math.floor(box[0] * width), top = Math.floor(box[1] * height);
  return { left, top, width: Math.min(width, Math.ceil(box[2] * width)) - left,
    height: Math.min(height, Math.ceil(box[3] * height)) - top };
}

async function openNative(record, options, callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eagle-native-'));
  const warnings = [];
  const runCommand = (program, args, settings = {}) => command(program, args, { ...settings, signal: options.signal });
  try {
    const paired = options.pairedItems || record.pairedItems || [];
    const raws = [record, ...paired].filter(item => RAW.has(extension(item)));
    let rawMeta = options.metadata;
    let rawSource;
    for (const raw of raws) {
      rawSource = fileOf(raw);
      if (!rawSource) continue;
      try {
        options.signal?.throwIfAborted();
        const args = ['-j', '-n', '-ImageWidth', '-ImageHeight', '-ExifImageWidth',
          '-ExifImageHeight', '-Orientation', rawSource];
        rawMeta ||= JSON.parse(await runCommand('exiftool', args))[0];
        for (const tag of ['JpgFromRaw', 'PreviewImage']) {
          try {
            const data = await runCommand('exiftool', ['-b', `-${tag}`, rawSource], { binary: true });
            const meta = await sharp(data).metadata();
            const width = rawMeta.ExifImageWidth || rawMeta.ImageWidth || raw.width;
            const height = rawMeta.ExifImageHeight || rawMeta.ImageHeight || raw.height;
            if (!width || !height || meta.width < width * 0.95 || meta.height < height * 0.95) {
              warnings.push(`${tag}: embedded preview is not full resolution`); continue;
            }
            return await consume(data, 'embedded-jpeg', rawMeta.Orientation || meta.orientation || 1);
          } catch (error) { options.signal?.throwIfAborted(); warnings.push(`${tag}: ${error.message}`); }
        }
      } catch (error) { options.signal?.throwIfAborted(); warnings.push(`exiftool unavailable: ${error.message}`); }
    }
    for (const item of [record, ...paired].filter(item => !RAW.has(extension(item)))) {
      const source = fileOf(item);
      if (!source) continue;
      try {
        if (extension(item) === 'heic' && process.platform === 'darwin') {
          const converted = path.join(temporary, 'heic.jpg');
          await runCommand('sips', ['-s', 'format', 'jpeg', source, '--out', converted]);
          return await consume(converted, 'heic');
        }
        return await consume(source, 'jpeg');
      } catch (error) { options.signal?.throwIfAborted(); warnings.push(`paired image: ${error.message}`); }
    }
    if (rawSource) {
      try {
        const decoded = path.join(temporary, 'decoded.jpg');
        const python = options.python || localSetting("EAGLE_PYTHON") ||
          (process.platform === 'win32' ? 'python_worker/.venv/Scripts/python.exe' : 'python3');
        await runCommand(python, [decoder, rawSource, decoded]);
        return await consume(decoded, 'decoded-raw', rawMeta?.Orientation || 1);
      } catch (error) { options.signal?.throwIfAborted(); warnings.push(`rawpy unavailable or decode failed: ${error.message}`); }
    }
    options.signal?.throwIfAborted();
    return { available: false, naReason: 'native-source-unavailable', warnings };

    async function consume(input, kind, orientation) {
      options.signal?.throwIfAborted();
      const meta = await sharp(input).metadata();
      orientation ||= meta.orientation || 1;
      const swapped = orientation >= 5 && orientation <= 8;
      const source = { width: swapped ? meta.height : meta.width, height: swapped ? meta.width : meta.height,
        rawWidth: meta.width, rawHeight: meta.height, orientation, kind, warnings: [...warnings] };
      // EXIF orientation can be absent from an extracted JPEG; source metadata is authoritative.
      const image = () => {
        let pipeline = sharp(input, { limitInputPixels: 160000000 });
        if ([2, 4, 5, 7].includes(orientation)) pipeline = pipeline.flop();
        const angle = ({ 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 })[orientation] || 0;
        return pipeline.rotate(angle);
      };
      return callback({ image, source });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function withNativeImage(record, options = {}, callback) {
  return serial(() => openNative(record, options, callback), { ...options, decodeBytes: nativeDecodeReservation(record, options) });
}

export async function nativeFingerprint(record, paired) {
  const parts = [];
  for (const item of [record, ...paired]) {
    const file = fileOf(item);
    if (!file) continue;
    try { const info = await stat(file); parts.push([file, info.size, info.mtimeMs]); } catch { parts.push([file, 'missing']); }
  }
  return parts;
}

async function trimCache(dir, maxBytes, maxEntries) {
  const files = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.jpg')) continue;
    const file = path.join(dir, name), info = await stat(file);
    files.push({ file, size: info.size, time: info.mtimeMs });
  }
  files.sort((a, b) => a.time - b.time);
  let bytes = files.reduce((sum, f) => sum + f.size, 0);
  while (files.length && (bytes > maxBytes || files.length > maxEntries)) {
    const file = files.shift(); bytes -= file.size;
    await rm(file.file, { force: true }); await rm(`${file.file}.json`, { force: true });
  }
}

/** Crop coordinates refer to upright normalized proxy pixels. Never resizes native pixels. */
export async function nativeCrop(record, box, options = {}) {
  if (!normalizedRect(box, 1, 1)) return { available: false, naReason: 'invalid-crop' };
  const paired = options.pairedItems || record.pairedItems || [];
  const key = crypto.createHash('sha256').update(JSON.stringify(['native-v1', await nativeFingerprint(record, paired), box,
    ...(process.platform === 'win32' ? [localSetting('EAGLE_EXIFTOOL')] : [])])).digest('hex');
  const dir = path.resolve(options.cacheDir || 'data/cache/focus-crops');
  const file = path.join(dir, `${key}.jpg`);
  return serial(async () => {
    await mkdir(dir, { recursive: true });
    try {
      const cached = JSON.parse(await readFile(`${file}.json`, 'utf8'));
      await stat(file); await utimes(file, new Date(), new Date());
      return { ...cached, path: file, cached: true };
    } catch { /* cache miss */ }
    const result = await openNative(record, options, async ({ image, source }) => {
      const rect = normalizedRect(box, source.width, source.height);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await image().extract(rect).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toFile(temporary);
        options.signal?.throwIfAborted();
        await replaceFile(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      const result = { available: true, source, rect };
      await writeFile(`${file}.json`, JSON.stringify(result));
      return { ...result, path: file, cached: false };
    });
    await trimCache(dir, options.maxBytes ?? 256 * 1024 * 1024, options.maxEntries ?? 1000);
    options.signal?.throwIfAborted();
    return result;
  }, { ...options, decodeBytes: nativeDecodeReservation(record, options) });
}
