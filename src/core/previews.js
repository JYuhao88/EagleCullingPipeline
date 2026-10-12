import { touchCache } from './cache-budget.js';
import { replaceFile } from './atomic-file.js';
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";
import { withNativeImage } from "./native-image.js";

const rawExtensions = new Set([
  "arw",
  "dng",
  "3fr",
  "cr2",
  "cr3",
  "nef",
  "raf",
  "orf",
  "rw2",
]);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function choosePreview(
  record,
  { cacheDir = "data/cache/previews" } = {},
) {
  const source = record.filePath || record.analysisPath || record.thumbnailPath;
  if (!source) return undefined;
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${source}|${record.size || 0}|${record.mtimeMs || 0}`)
    .digest("hex");
  const output = path.resolve(cacheDir, `${fingerprint}.jpg`);
  if (await exists(output)) {
    try {
      const stats = await sharp(output).stats();
      const deviation = stats.channels.reduce(
        (sum, channel) => sum + channel.stdev,
        0,
      );
      if (deviation >= 0.5) {
        record.previewSource = "cache";
        // Old thumbnails remain readable, but a new analysis must establish a source mapping.
        record.sourceMapping = JSON.parse(await readFile(`${output}.json`, "utf8"));
        await touchCache(output);
        await touchCache(`${output}.json`);
        return output;
      }
    } catch {
      // Rebuild an invalid or truncated cache entry.
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  const extension = String(
    record.ext || path.extname(source).slice(1),
  ).toLowerCase();
  const failures = [];
  async function normalize(input) {
    const temporary = `${output}.normalized`;
    const sample = await sharp(input).rotate().removeAlpha().raw().stats();
    const deviation = sample.channels.reduce(
      (sum, channel) => sum + channel.stdev,
      0,
    );
    if (deviation < 0.5) throw new Error("preview pixels are uniform");
    await sharp(input)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toFile(temporary);
    await replaceFile(temporary, output);
    return output;
  }
  try {
    if (extension === "heic" && process.platform === "darwin") {
      const native = await withNativeImage(record, {}, async ({ image, source }) => {
        await image().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(output);
        const proxy = await sharp(output).metadata();
        record.sourceMapping = { ...source, proxyWidth: proxy.width, proxyHeight: proxy.height, reliable: true };
        record.previewSource = source.kind;
        await writeFile(`${output}.json`, JSON.stringify(record.sourceMapping));
        return output;
      });
      if (typeof native === "string") return native;
      throw new Error(native.warnings?.join("；") || "HEIC unavailable");
    }
    if (rawExtensions.has(extension)) {
      const native = await withNativeImage(record, {}, async ({ image, source }) => {
        await image().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 88 }).toFile(output);
        const proxy = await sharp(output).metadata();
        record.sourceMapping = { ...source, proxyWidth: proxy.width, proxyHeight: proxy.height, reliable: true };
        record.previewSource = source.kind;
        if (source.warnings.length) record.previewWarning = source.warnings.join("；");
        await writeFile(`${output}.json`, JSON.stringify(record.sourceMapping));
        return output;
      });
      if (typeof native === "string") return native;
      record.previewWarning = native.warnings?.join("；");
      if (record.thumbnailPath && (await exists(record.thumbnailPath))) {
        record.previewSource = "eagle-thumbnail";
        record.sourceMapping = { reliable: false, naReason: "native-source-unavailable" };
        const preview = await normalize(record.thumbnailPath);
        await writeFile(`${output}.json`, JSON.stringify(record.sourceMapping));
        return preview;
      }
      record.previewSource = "unavailable";
      record.previewWarning = "RAW 没有可用 Eagle 缩略图";
      return undefined;
    }
    const sourceMeta = await sharp(source, { failOn: "none" }).metadata();
    await sharp(source, { failOn: "none" })
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88 })
      .toFile(output);
    const proxy = await sharp(output).metadata();
    const swapped = sourceMeta.orientation >= 5 && sourceMeta.orientation <= 8;
    record.sourceMapping = { width: swapped ? sourceMeta.height : sourceMeta.width, height: swapped ? sourceMeta.width : sourceMeta.height,
      proxyWidth: proxy.width, proxyHeight: proxy.height, orientation: sourceMeta.orientation || 1, kind: "jpeg", reliable: true };
    await writeFile(`${output}.json`, JSON.stringify(record.sourceMapping));
    return await normalize(output);
  } catch (error) {
    failures.push(error.message);
    if (record.thumbnailPath && (await exists(record.thumbnailPath))) {
      try {
        record.previewSource = "eagle-thumbnail";
        record.previewWarning = `主预览失败，已降级到 Eagle 缩略图：${failures.join("；")}`;
        return await normalize(record.thumbnailPath);
      } catch (fallbackError) {
        failures.push(fallbackError.message);
      }
    }
    record.previewSource = "unavailable";
    record.previewWarning = `预览生成失败：${failures.join("；")}`;
    return undefined;
  }
}
