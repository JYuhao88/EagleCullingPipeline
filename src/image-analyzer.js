import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { SCORING_VERSION } from "./plugin/analysis-version.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"]);
const PROXY_EXTENSIONS = new Set(["arw", "dng", "3fr", "heic", "cr2", "nef", "raf", "rw2", "orf", "srw"]);
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
    const original = files.find((file) => file.isFile() && file.name !== "metadata.json" && !file.name.toLowerCase().includes("thumbnail"));
    const image = original && IMAGE_EXTENSIONS.has(path.extname(original.name).slice(1).toLowerCase()) ? original : undefined;
    const thumbnail = files.find((file) => file.isFile() && file.name.toLowerCase().includes("thumbnail") && IMAGE_EXTENSIONS.has(path.extname(file.name).slice(1).toLowerCase()));
    const ext = (metadata.ext || path.extname(original?.name || "").slice(1)).toLowerCase();
    const proxyOnly = !image && PROXY_EXTENSIONS.has(ext) && thumbnail;
    if (!image && !proxyOnly) continue;
    records.push({
      id: metadata.id || entry.name.replace(/\.info$/, ""),
      name: metadata.name || image.name,
      filePath: path.join(infoPath, original?.name || image.name),
      thumbnailPath: thumbnail ? path.join(infoPath, thumbnail.name) : undefined,
      analysisPath: proxyOnly ? path.join(infoPath, thumbnail.name) : undefined,
      ext: metadata.ext || ext,
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

export function scoreQuality({ sharpness, clippedHigh, clippedLow, width, height, resolutionVerified = true }) {
  const sharpnessScore = Math.max(0, Math.min(100, 35 + 18 * Math.log10(1 + sharpness)));
  const exposurePenalty = Math.min(60, (clippedHigh + clippedLow) * 180);
  const resolutionScore = resolutionVerified ? Math.max(0, Math.min(100, Math.log10(Math.max(1, width * height)) * 11)) : 0;
  const weighted = sharpnessScore * 0.45 + (100 - exposurePenalty) * 0.2 + resolutionScore * 0.15;
  return Math.round(Math.max(0, Math.min(100, weighted / (resolutionVerified ? 0.8 : 0.65))) * 100) / 100;
}

export async function analyzeImage(record) {
  const analysisPath = record.analysisPath || record.filePath;
  const resolutionVerified = analysisPath === record.filePath;
  const image = sharp(analysisPath, { failOn: "none" });
  const metadata = await image.metadata();
  const hashBuffer = await image.clone().resize({ width: 32, height: 32, fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const gray = Array.from(hashBuffer.data);
  const phash = dctHash(gray, hashBuffer.info.width, hashBuffer.info.height);

  const sample = await image.clone().resize({ width: 96, height: 96, fit: "inside" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
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
    width: resolutionVerified ? (metadata.width || record.width || 0) : (record.width || metadata.width || 0),
    height: resolutionVerified ? (metadata.height || record.height || 0) : (record.height || metadata.height || 0),
  };
  const qualityFlags = [];
  if (sharpness < 3) qualityFlags.push("possibly-blurry");
  if (clippedHigh >= 0.05) qualityFlags.push("overexposed");
  if (clippedLow >= 0.05) qualityFlags.push("underexposed");
  if (resolutionVerified && Math.min(dimensions.width, dimensions.height) < 800) qualityFlags.push("low-resolution");
  return {
    ...record,
    width: dimensions.width,
    height: dimensions.height,
    sha256: (await hashFile(analysisPath)).sha256,
    analysisSource: analysisPath === record.filePath ? "original" : "proxy",
    resolutionVerified,
    scoringVersion: SCORING_VERSION,
    phash,
    metrics: {
      meanLuma: Math.round(avg * 100) / 100,
      lumaVariance: Math.round(variance(luma, avg) * 100) / 100,
      sharpness: Math.round(sharpness * 1000) / 1000,
      clippedHigh: Math.round(clippedHigh * 10000) / 10000,
      clippedLow: Math.round(clippedLow * 10000) / 10000,
      compositionScore: null,
      subjectScore: null,
    },
    qualityScore: scoreQuality({ sharpness, clippedHigh, clippedLow, resolutionVerified, ...dimensions }),
    qualityFlags,
    qualityMethod: "heuristic-preview",
    // No labelled accuracy/calibration set exists yet. A fixed 0.78 is not a
    // probability, and edge/contrast proxies are not aesthetic/subject models.
    confidence: null,
    confidenceCalibrated: false,
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
  if (!face || face.available === false || face.error) return { ...item, face: {...face,available:false,eyeAssessment:"unavailable"} };
  const count = Number.isSafeInteger(face.faceCount) ? face.faceCount : (face.faces || []).length;
  const closedEyes = (face?.faces || []).some((entry) => entry.eyesClosed);
  const eyeAssessment = closedEyes ? "possible-closed" : !count ? "not-detected" : (face.faces || []).length < count || (face.faces || []).some(entry=>entry.eyesAssessed === false) ? "incomplete" : "no-closed-signal";
  face = {...face,eyeAssessment};
  if (!closedEyes) return { ...item, face };
  const qualityFlags = [...new Set([...(item.qualityFlags || []), "eyes-closed"])];
  return {
    ...item,
    face,
    qualityFlags,
    qualityScore: Math.round(Math.max(0, (item.qualityScore || 0) - 25) * 100) / 100,
    confidence: null,
    confidenceCalibrated: false,
  };
}

export function clusterByPhash(items, threshold = 8) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) throw new Error("pHash threshold must be an integer from 0 to 64");
  const popcount = (value) => {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const prepared = items.map((item) => {
    const valid = typeof item.phash === "string" && /^[01]{1,64}$/.test(item.phash);
    return { item, length:valid ? item.phash.length : 0, high:valid ? parseInt(item.phash.slice(0,32),2) : 0,
      low:valid && item.phash.length > 32 ? parseInt(item.phash.slice(32),2) : 0,
      sha:typeof item.sha256 === "string" && /^[a-f\d]{64}$/i.test(item.sha256) ? item.sha256.toLowerCase() : null };
  }).sort((a,b) => (Number.isFinite(b.item.qualityScore) ? b.item.qualityScore : 0) - (Number.isFinite(a.item.qualityScore) ? a.item.qualityScore : 0) || String(a.item.id).localeCompare(String(b.item.id)));
  const distance = (a,b) => a.sha && a.sha === b.sha ? 0 : a.length && a.length === b.length
    ? popcount(a.high ^ b.high) + popcount(a.low ^ b.low) : Infinity;
  // Quality-first deterministic complete-link partition: every pair in a group
  // must satisfy the threshold, not merely be connected by an intermediate shot.
  const groups = [];
  for (const candidate of prepared) {
    let group = null;
    for (const existing of groups) {
      if (distance(candidate,existing.members[0]) > threshold) continue;
      if (existing.members.every(member=>distance(candidate,member)<=threshold)) {group=existing;break;}
    }
    if (group) group.members.push(candidate);
    else groups.push({members:[candidate]});
  }
  return groups.map(({members}, index) => ({
    groupId: `phash-${String(index + 1).padStart(4, "0")}`,
    size: members.length,
    representativeId: members[0].item.id,
    similarityMethod: "phash-pairwise-v2",
    phashThreshold: threshold,
    items: members.map(member=>({...member.item,phashDistance:distance(member,members[0])})),
  }));
}
