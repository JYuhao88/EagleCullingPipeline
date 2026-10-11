import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { atomicJson, validContentHash } from './feature-store.js';

// No pixel decoding or copies at tier 0. Caller must explicitly enable tier 1.
export class PixelRetention {
  constructor(root = 'data/learning') { this.root = root; this.queue = Promise.resolve(); }
  retain(hash, options = {}) {
    const operation = this.queue.then(() => this._retain(hash, options));
    this.queue = operation.catch(() => {}); return operation;
  }
  async _retain(hash, { tier = 0, sourcePath, faces = [], regions = [], retentionDays = null } = {}) {
    if (!validContentHash(hash)) throw new Error('Invalid content SHA-256');
    if (![0, 1].includes(tier)) throw new Error('Only retention tiers 0 and 1 are implemented');
    if (tier === 0) return { tier: 0, files: [], reason: 'features-only' };
    if (!sourcePath) return { tier: 1, files: [], unavailable: true, reason: 'original-unavailable' };
    const directory = path.join(this.root, 'pixels', 'v1', hash.toLowerCase());
    // Serial native decode, no model requests. EXIF orientation is applied before coordinates.
    const image = sharp(sourcePath, { limitInputPixels: 120_000_000 }).rotate().raw();
    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    const width = info.width, height = info.height;
    await mkdir(directory, { recursive: true });
    const files = [];
    const overview = path.join(directory, 'overview.jpg');
    await sharp(data, { raw: { width, height, channels: info.channels } })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(overview);
    files.push({ kind: 'overview', file: overview });
    const boxes = [...regions, ...faces.map(face => face.box)].filter(box =>
      Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)).slice(0, 4);
    if (boxes.length < 2) boxes.push([0.25, 0.25, 0.75, 0.75], [0.35, 0.1, 0.65, 0.4]);
    for (const [index, box] of boxes.slice(0, 4).entries()) {
      const cropWidth = Math.min(512, width), cropHeight = Math.min(512, height);
      const left = Math.max(0, Math.min(width - cropWidth, Math.round((box[0] + box[2]) * width / 2 - cropWidth / 2)));
      const top = Math.max(0, Math.min(height - cropHeight, Math.round((box[1] + box[3]) * height / 2 - cropHeight / 2)));
      const file = path.join(directory, `native-${index}.jpg`);
      await sharp(data, { raw: { width, height, channels: info.channels } })
        .extract({ left, top, width: cropWidth, height: cropHeight }).jpeg({ quality: 92 }).toFile(file);
      files.push({ kind: 'native', file, region: { left, top, width: cropWidth, height: cropHeight } });
    }
    const savedAt = new Date().toISOString();
    const manifest = { schemaVersion: 1, hash, tier: 1, savedAt, files, source: { width, height }, retentionDays,
      expiresAt: Number.isFinite(retentionDays) && retentionDays > 0
        ? new Date(Date.now() + retentionDays * 86400000).toISOString() : null };
    await atomicJson(path.join(directory, 'manifest.json'), manifest);
    return manifest;
  }
}
