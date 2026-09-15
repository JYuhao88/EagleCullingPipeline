import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"]);
// Keep libvips from competing with the Eagle UI or exhausting RAM during a
// large-library scan. Override per machine when a dedicated worker is used.
const sharpConcurrency = Math.max(1, Math.min(8, Number(process.env.EAGLE_SHARP_CONCURRENCY || 2)));
sharp.concurrency(sharpConcurrency);
sharp.cache({ memory: 128, files: 0, items: 100 });

export async function listEagleImages(libraryPath, { limit } = {}) {
  const imagesPath = path.join(libraryPath, "images");
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".info")) entries.push({ entry, fullPath });
        else await walk(fullPath);
      }
    }
  }
  await walk(imagesPath);
  const records = [];
  for (const { entry, fullPath: infoPath } of entries) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(infoPath, "metadata.json"), "utf8"));
    } catch {
      continue;
    }
    const files = await readdir(infoPath, { withFileTypes: true });
    const image = files.find((file) => {
      if (!file.isFile() || file.name === "metadata.json" || file.name.toLowerCase().includes("thumbnail")) return false;
      return IMAGE_EXTENSIONS.has(path.extname(file.name).slice(1).toLowerCase());
    });
    const thumbnail = files.find((file) => file.isFile() && file.name.toLowerCase().includes("thumbnail") && IMAGE_EXTENSIONS.has(path.extname(file.name).slice(1).toLowerCase()));
    if (!image) continue;
    records.push({
      id: metadata.id || entry.name.replace(/\.info$/, ""),
      name: metadata.name || image.name,
      filePath: path.join(infoPath, image.name),
      thumbnailPath: thumbnail ? path.join(infoPath, thumbnail.name) : undefined,
      ext: metadata.ext || path.extname(image.name).slice(1).toLowerCase(),
      width: metadata.width,
      height: metadata.height,
      size: metadata.size,
      tags: metadata.tags || [],
      folders: metadata.folders || [],
      star: metadata.star ?? 0,
    });
    if (limit && records.length >= limit) break;
  }
  return records;
}

function grayscaleLuma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, avg = mean(values)) {
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function dctHash(gray, width, height) {
  const n = 8;
  const coefficients = [];
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
          sum += gray[y * width + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * width))
            * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * height));
        }
      }
      coefficients.push(sum);
    }
  }
  const low = coefficients.slice(1);
  const median = [...low].sort((a, b) => a - b)[Math.floor(low.length / 2)];
  return low.map((value) => (value > median ? "1" : "0")).join("");
}

export function hammingDistance(left, right) {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) distance += 1;
  return distance;
}

export function scoreQuality({ sharpness, clippedHigh, clippedLow, width, height, compositionScore = 50, subjectScore = 50 }) {
  const sharpnessScore = Math.max(0, Math.min(100, 35 + 18 * Math.log10(1 + sharpness)));
  const exposurePenalty = Math.min(60, (clippedHigh + clippedLow) * 180);
  const resolutionScore = Math.max(0, Math.min(100, Math.log10(Math.max(1, width * height)) * 11));
  return Math.round(Math.max(0, Math.min(100, sharpnessScore * 0.45 + (100 - exposurePenalty) * 0.2 + resolutionScore * 0.15 + compositionScore * 0.1 + subjectScore * 0.1)) * 100) / 100;
}

export async function analyzeImage(record) {
  const analysisPath = record.analysisPath || record.filePath;
  const image = sharp(analysisPath, { failOn: "none" });
  const metadata = await image.metadata();
  const hashBuffer = await image.clone().resize({ width: 32, height: 32, fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const gray = Array.from(hashBuffer.data);
  const phash = dctHash(gray, hashBuffer.info.width, hashBuffer.info.height);

  const sample = await image.clone().resize({ width: 96, height: 96, fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const luma = [];
  for (let i = 0; i < sample.data.length; i += sample.info.channels) {
    luma.push(grayscaleLuma(sample.data[i], sample.data[i + 1], sample.data[i + 2]));
  }
  const avg = mean(luma);
  let gradient = 0;
  const sw = sample.info.width;
  for (let y = 0; y < sample.info.height; y += 1) {
    for (let x = 0; x < sw - 1; x += 1) gradient += Math.abs(luma[y * sw + x + 1] - luma[y * sw + x]);
  }
  const sharpness = gradient / Math.max(1, luma.length);
  const clippedHigh = luma.filter((value) => value >= 250).length / luma.length;
  const clippedLow = luma.filter((value) => value <= 5).length / luma.length;
  const dimensions = {
    width: record.analysisPath ? (record.width || metadata.width || 0) : (metadata.width || record.width || 0),
    height: record.analysisPath ? (record.height || metadata.height || 0) : (metadata.height || record.height || 0),
  };
  const qualityFlags = [];
  if (sharpness < 3) qualityFlags.push("possibly-blurry");
  if (clippedHigh >= 0.05) qualityFlags.push("overexposed");
  if (clippedLow >= 0.05) qualityFlags.push("underexposed");
  if (Math.min(dimensions.width, dimensions.height) < 800) qualityFlags.push("low-resolution");
  const grid = [];
  for (let gy = 0; gy < 3; gy += 1) for (let gx = 0; gx < 3; gx += 1) {
    const values = [];
    const x0 = Math.floor(gx * sw / 3); const x1 = Math.floor((gx + 1) * sw / 3);
    const y0 = Math.floor(gy * sample.info.height / 3); const y1 = Math.floor((gy + 1) * sample.info.height / 3);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) values.push(luma[y * sw + x]);
    grid.push({ gx, gy, variance: variance(values) });
  }
  const strongestCell = [...grid].sort((a, b) => b.variance - a.variance)[0];
  const compositionScore = Math.round(Math.max(0, Math.min(100, 45 + (strongestCell.variance / Math.max(1, variance(luma))) * 20)) * 100) / 100;
  const subjectScore = Math.round(Math.max(0, Math.min(100, 35 + Math.sqrt(Math.max(0, strongestCell.variance)) * 4)) * 100) / 100;
  return {
    ...record,
    width: dimensions.width,
    height: dimensions.height,
    sha256: (await hashFile(analysisPath)).sha256,
    analysisSource: analysisPath === record.filePath ? "original" : "proxy",
    phash,
    metrics: {
      meanLuma: Math.round(avg * 100) / 100,
      lumaVariance: Math.round(variance(luma, avg) * 100) / 100,
      sharpness: Math.round(sharpness * 1000) / 1000,
      clippedHigh: Math.round(clippedHigh * 10000) / 10000,
      clippedLow: Math.round(clippedLow * 10000) / 10000,
      compositionScore,
      subjectScore,
    },
    qualityScore: scoreQuality({ sharpness, clippedHigh, clippedLow, compositionScore, subjectScore, ...dimensions }),
    qualityFlags,
    confidence: qualityFlags.length === 0 ? 0.78 : Math.max(0.35, 0.78 - qualityFlags.length * 0.12),
    analyzedAt: new Date().toISOString(),
  };
}

export async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { sha256: hash.digest("hex") };
}

/** Merge face/eye findings into the explainable quality fields. */
export function applyFaceQuality(item, face) {
  const closedEyes = (face?.faces || []).some((entry) => entry.eyesClosed);
  if (!closedEyes) return { ...item, face };
  const qualityFlags = [...new Set([...(item.qualityFlags || []), "eyes-closed"])];
  return {
    ...item,
    face,
    qualityFlags,
    qualityScore: Math.round(Math.max(0, (item.qualityScore || 0) - 25) * 100) / 100,
    confidence: Math.max(0.25, (item.confidence ?? 0.78) - 0.15),
  };
}

export function clusterByPhash(items, threshold = 8) {
  const parent = items.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[i].sha256 === items[j].sha256 || hammingDistance(items[i].phash, items[j].phash) <= threshold) union(i, j);
    }
  }
  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ ...item, phashDistance: 0 });
  });
  return [...groups.values()].map((members, index) => ({
    groupId: `phash-${String(index + 1).padStart(4, "0")}`,
    size: members.length,
    representativeId: [...members].sort((a, b) => b.qualityScore - a.qualityScore)[0].id,
    items: members,
  }));
}
