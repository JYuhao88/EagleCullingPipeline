import { localSetting } from './local-config.js';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, stat, readFile, writeFile, readdir, utimes, rename } from 'node:fs/promises';
import sharp from 'sharp';

const RAW = new Set(['arw', 'dng', '3fr', 'cr2', 'cr3', 'nef', 'raf', 'orf', 'rw2']);
const decoder = fileURLToPath(new URL('../../ml/raw/decode.py', import.meta.url));
const fileOf = item => item?.filePath || item?.path || item?.analysisPath;
const extension = item => String(item?.ext || path.extname(fileOf(item) || '').slice(1)).toLowerCase();
let queue = Promise.resolve();
// Native decodes are deliberately serial: full-resolution buffers are transient.
async function serial(fn) {
  const previous = queue;
  let release;
  queue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

function command(program, args, { binary = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', '10', program, ...args]);
    const chunks = []; let bytes = 0; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk);
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
  try {
    const paired = options.pairedItems || record.pairedItems || [];
    const raws = [record, ...paired].filter(item => RAW.has(extension(item)));
    let rawMeta = options.metadata;
    let rawSource;
    for (const raw of raws) {
      rawSource = fileOf(raw);
      if (!rawSource) continue;
      try {
        const args = ['-j', '-n', '-ImageWidth', '-ImageHeight', '-ExifImageWidth',
          '-ExifImageHeight', '-Orientation', rawSource];
        rawMeta ||= JSON.parse(await command('exiftool', args))[0];
        for (const tag of ['JpgFromRaw', 'PreviewImage']) {
          try {
            const data = await command('exiftool', ['-b', `-${tag}`, rawSource], { binary: true });
            const meta = await sharp(data).metadata();
            const width = rawMeta.ExifImageWidth || rawMeta.ImageWidth || raw.width;
            const height = rawMeta.ExifImageHeight || rawMeta.ImageHeight || raw.height;
            if (!width || !height || meta.width < width * 0.95 || meta.height < height * 0.95) {
              warnings.push(`${tag}: embedded preview is not full resolution`); continue;
            }
            return await consume(data, 'embedded-jpeg', rawMeta.Orientation || meta.orientation || 1);
          } catch (error) { warnings.push(`${tag}: ${error.message}`); }
        }
      } catch (error) { warnings.push(`exiftool unavailable: ${error.message}`); }
    }
    for (const item of [record, ...paired].filter(item => !RAW.has(extension(item)))) {
      const source = fileOf(item);
      if (!source) continue;
      try {
        if (extension(item) === 'heic' && process.platform === 'darwin') {
          const converted = path.join(temporary, 'heic.jpg');
          await command('sips', ['-s', 'format', 'jpeg', source, '--out', converted]);
          return await consume(converted, 'heic');
        }
        return await consume(source, 'jpeg');
      } catch (error) { warnings.push(`paired image: ${error.message}`); }
    }
    if (rawSource) {
      try {
        const decoded = path.join(temporary, 'decoded.jpg');
        await command(options.python || localSetting("EAGLE_PYTHON") || 'python3', [decoder, rawSource, decoded]);
        return await consume(decoded, 'decoded-raw', rawMeta?.Orientation || 1);
      } catch (error) { warnings.push(`rawpy unavailable or decode failed: ${error.message}`); }
    }
    return { available: false, naReason: 'native-source-unavailable', warnings };

    async function consume(input, kind, orientation) {
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
  return serial(() => openNative(record, options, callback));
}

async function fingerprint(record, paired) {
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
  const key = crypto.createHash('sha256').update(JSON.stringify(['native-v1', await fingerprint(record, paired), box])).digest('hex');
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
      const temporary = `${file}.tmp`;
      await image().extract(rect).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toFile(temporary);
      await rename(temporary, file);
      const result = { available: true, source, rect };
      await writeFile(`${file}.json`, JSON.stringify(result));
      return { ...result, path: file, cached: false };
    });
    await trimCache(dir, options.maxBytes ?? 256 * 1024 * 1024, options.maxEntries ?? 1000);
    return result;
  });
}
