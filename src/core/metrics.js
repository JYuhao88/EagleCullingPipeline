import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { enrichCaptureMetadata, assignCaptureSessions } from "./capture-metadata.js";
import path from "node:path";
import sharp from "sharp";
import { createRequire } from "node:module";
const scoringConfig = createRequire(import.meta.url)("./ranking-weights.json");
const exposureConfig = scoringConfig.exposure;
export const SCORING_VERSION = "heuristic-v4-sky-eye-gates";
export const METRICS_DEFAULTS = {
  clippedFraction: 0.08,
  brightMean: 180,
  darkMean: 70,
};

/** Exposure is suitability, not brightness.  Keep a broad mid-tone band so
 * intentional low/high-key frames are viable, while clipping remains costly. */
export function exposureSuitability({ meanLuma, clippedHigh = 0, clippedLow = 0, midtoneFraction, faceExposure, skyExposure } = {}) {
  const c = exposureConfig;
  if (skyExposure?.version === 'sky-v1' && Number.isFinite(skyExposure.subject?.clippedHigh))
    clippedHigh = skyExposure.subject.clippedHigh;
  const mean = Number.isFinite(meanLuma) ? meanLuma : 128;
  midtoneFraction = faceExposure?.midtoneFraction ?? midtoneFraction;
  const mid = Number.isFinite(midtoneFraction)
    ? midtoneFraction
    : (mean >= 24 && mean <= 232 ? 1 : 0.5);
  const subjectMean = faceExposure?.meanLuma ?? mean;
  const intent = 1 - Math.min(1, Math.max(0, Math.abs(subjectMean - c.intentMean) - c.intentTolerance) / c.intentScale);
  const clipping = faceExposure
    ? faceExposure.clippedHigh * c.faceHighlightPenalty + faceExposure.clippedLow * c.faceShadowPenalty
    : clippedHigh * c.globalHighlightPenalty + clippedLow * c.globalShadowPenalty;
  return Math.max(0, Math.min(1, 1 - c.midtoneWeight * (1 - mid) - c.brightnessWeight * (1 - intent) - clipping));
}

function exposureDistribution(luma) {
  const c = exposureConfig;
  return {
    meanLuma: mean(luma),
    clippedHigh: luma.filter((v) => v >= c.highlightThreshold).length / luma.length,
    clippedLow: luma.filter((v) => v <= c.shadowThreshold).length / luma.length,
    midtoneFraction: luma.filter((v) => v >= c.midtoneLow && v <= c.midtoneHigh).length / luma.length,
  };
}

/** Conservative sky proxy: bright, locally smooth, connected to the top.
 * A component reaching the lower frame is not sky: whole-frame clipping must
 * remain measurable. This is a spatial heuristic, not semantic segmentation. */
export function skyExposure(luma, width, height, config = scoringConfig.sky, { includeMask = false } = {}) {
  const n = width * height;
  if (!n || luma.length !== n) return null;
  const candidate = new Uint8Array(n), seen = new Uint8Array(n), mask = new Uint8Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const neighbors = [x > 0 ? i - 1 : i, x + 1 < width ? i + 1 : i,
      y > 0 ? i - width : i, y + 1 < height ? i + width : i];
    const gradient = Math.max(...neighbors.map(j => Math.abs(luma[i] - luma[j])));
    candidate[i] = luma[i] >= config.brightLuma && gradient <= config.maxGradient ? 1 : 0;
  }
  for (let x = 0; x < width; x++) {
    if (!candidate[x] || seen[x]) continue;
    const component = [x]; seen[x] = 1;
    let bottom = 0;
    for (let q = 0; q < component.length; q++) {
      const i = component[q], cx = i % width, cy = Math.floor(i / width);
      bottom = Math.max(bottom, cy);
      for (const j of [cx > 0 ? i - 1 : -1, cx + 1 < width ? i + 1 : -1,
        cy > 0 ? i - width : -1, cy + 1 < height ? i + width : -1]) {
        if (j >= 0 && candidate[j] && !seen[j]) { seen[j] = 1; component.push(j); }
      }
    }
    if (bottom / height >= config.maxDepth || component.length / n < config.minArea) continue;
    for (const i of component) mask[i] = 1;
  }
  const subject = [], sky = [];
  for (let i = 0; i < n; i++) (mask[i] ? sky : subject).push(luma[i]);
  // Never explain away an image with insufficient remaining subject area.
  if (subject.length / n < config.minSubjectArea) return {
    version: 'sky-v1', skyFraction: 0, skyClippedFraction: 0, subject: exposureDistribution(luma),
    ...(includeMask ? { mask: new Uint8Array(n) } : {}) };
  return { version: 'sky-v1', skyFraction: sky.length / n,
    skyClippedFraction: sky.filter(v => v >= exposureConfig.highlightThreshold).length / n,
    subject: exposureDistribution(subject), ...(includeMask ? { mask } : {}) };
}

export async function measureSkyExposure(preview) {
  const { data, info } = await sharp(preview).resize({ width: 96, height: 96, fit: 'inside' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const luma = Array.from({ length: info.width * info.height }, (_, i) =>
    grayscaleLuma(data[i * info.channels], data[i * info.channels + 1], data[i * info.channels + 2]));
  return skyExposure(luma, info.width, info.height);
}

/** Measure the largest detected face; absent/invalid faces keep scene exposure. */
export async function measureFaceExposure(preview, faces = []) {
  const face = faces.filter((f) => Array.isArray(f.box) && f.box.length === 4 && f.box.every(Number.isFinite) &&
    f.box[2] > f.box[0] && f.box[3] > f.box[1] &&
    (!Number.isFinite(f.confidence) || f.confidence >= 0.5)).sort((a, b) =>
    (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
  if (!face || !preview) return null;
  const { data, info } = await sharp(preview).resize({ width: 512, height: 512, fit: "inside" })
    .removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const luma = [];
  const [x0, y0, x1, y1] = face.box.map((v) => Math.max(0, Math.min(1, v)));
  if ((x1 - x0) * info.width < 8 || (y1 - y0) * info.height < 8) return null;
  for (let y = Math.floor(y0 * info.height); y < Math.ceil(y1 * info.height); y += 1) {
    for (let x = Math.floor(x0 * info.width); x < Math.ceil(x1 * info.width); x += 1) {
      const i = (y * info.width + x) * info.channels;
      luma.push(grayscaleLuma(data[i], data[i + 1], data[i + 2]));
    }
  }
  return luma.length ? exposureDistribution(luma) : null;
}

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "tif",
  "tiff",
  "bmp",
]);
const PROXY_EXTENSIONS = new Set([
  "arw",
  "dng",
  "3fr",
  "heic",
  "cr2",
  "nef",
  "raf",
  "rw2",
  "orf",
  "srw",
]);
// Keep libvips from competing with the Eagle UI or exhausting RAM during a
// large-library scan. Override per machine when a dedicated worker is used.
const sharpConcurrency = Math.max(
  1,
  Math.min(8, Number(process.env.EAGLE_SHARP_CONCURRENCY || 2)),
);
sharp.concurrency(sharpConcurrency);
sharp.cache({ memory: 128, files: 0, items: 100 });

export async function listEagleImages(libraryPath, { limit, metadataReader, signal, checkpoint, onProgress } = {}) {
  const imagesPath = path.join(libraryPath, "images");
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".info")) entries.push({ entry, fullPath });
        else await walk(fullPath);
      }
    }
  }
  await walk(imagesPath);
  const records = [];
  const restored = new Set();
  for (const { entry, fullPath: infoPath } of entries) {
    signal?.throwIfAborted();
    const saved = checkpoint ? await checkpoint.get(`scan:${entry.name.replace(/\.info$/, "")}`) : null;
    if (saved) { records.push(saved); restored.add(saved.id); if (limit && records.length >= limit) break; continue; }
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(path.join(infoPath, "metadata.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const files = await readdir(infoPath, { withFileTypes: true });
    const original = files.find(
      (file) =>
        file.isFile() &&
        file.name !== "metadata.json" &&
        !file.name.toLowerCase().includes("thumbnail"),
    );
    const image =
      original &&
      IMAGE_EXTENSIONS.has(path.extname(original.name).slice(1).toLowerCase())
        ? original
        : undefined;
    const thumbnail = files.find(
      (file) =>
        file.isFile() &&
        file.name.toLowerCase().includes("thumbnail") &&
        IMAGE_EXTENSIONS.has(path.extname(file.name).slice(1).toLowerCase()),
    );
    const ext = (
      metadata.ext || path.extname(original?.name || "").slice(1)
    ).toLowerCase();
    const proxyOnly = !image && PROXY_EXTENSIONS.has(ext) && thumbnail;
    if (!original && !proxyOnly) continue;
    const filePath = path.join(infoPath, original?.name || image.name);
    let fileStat = null;
    try {
      const info = await stat(filePath);
      fileStat = { size: info.size, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs };
    } catch { /* A file can disappear while Eagle is importing it. */ }
    records.push({
      id: metadata.id || entry.name.replace(/\.info$/, ""),
      name: metadata.name || original?.name || entry.name,
      filePath,
      fileStat,
      thumbnailPath: thumbnail
        ? path.join(infoPath, thumbnail.name)
        : undefined,
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
  await enrichCaptureMetadata(records.filter(record => !restored.has(record.id)),
    { reader: metadataReader, signal, checkpoint, onProgress });
  assignCaptureSessions(records);
  return records;
}

function grayscaleLuma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, avg = mean(values)) {
  return (
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  );
}

function dctHash(gray, width, height) {
  const n = 8;
  const coefficients = [];
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
          sum +=
            gray[y * width + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * width)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * height));
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
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) distance += 1;
  return distance;
}

export function scoreQuality({
  sharpness,
  clippedHigh,
  clippedLow,
  width,
  height,
  resolutionVerified = true,
}) {
  const sharpnessScore = Math.max(
    0,
    Math.min(100, 35 + 18 * Math.log10(1 + sharpness)),
  );
  const exposurePenalty = Math.min(60, (clippedHigh + clippedLow) * 180);
  const resolutionScore = resolutionVerified
    ? Math.max(0, Math.min(100, Math.log10(Math.max(1, width * height)) * 11))
    : 0;
  const weighted =
    sharpnessScore * 0.45 +
    (100 - exposurePenalty) * 0.2 +
    resolutionScore * 0.15;
  return (
    Math.round(
      Math.max(0, Math.min(100, weighted / (resolutionVerified ? 0.8 : 0.65))) *
        100,
    ) / 100
  );
}

/** Fixed-scale details; HH median is robust to sparse edges, but dense texture
 * can still resemble noise. Gates require independent low TOPIQ quality. */
export async function measureTechnicalDetail(filePath) {
  const { data, info } = await sharp(filePath).rotate()
    .resize({ width: 512, height: 512, fit: "inside" }).removeAlpha()
    .toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.width < 3 || info.height < 3) return null;
  const gray = Float32Array.from({ length: info.width * info.height }, (_, i) =>
    0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2]);
  let sum = 0, square = 0;
  const residuals = [];
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const i = y * info.width + x;
    const lap = gray[i - 1] + gray[i + 1] + gray[i - info.width] + gray[i + info.width] - 4 * gray[i];
    sum += lap; square += lap * lap;
    residuals.push(Math.abs(gray[i] - gray[i + 1] - gray[i + info.width] + gray[i + info.width + 1]) / 2);
  }
  residuals.sort((a, b) => a - b);
  const n = residuals.length;
  return { version: "detail-512-v1", laplacianVariance: square / n - (sum / n) ** 2,
    noiseSigma: residuals[Math.floor(n / 2)] / 0.6745 };
}

export async function analyzeImage(record) {
  const analysisPath = record.analysisPath || record.filePath;
  const resolutionVerified = analysisPath === record.filePath;
  const image = sharp(analysisPath, { failOn: "none" });
  const metadata = await image.metadata();
  const hashBuffer = await image
    .clone()
    .resize({ width: 32, height: 32, fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gray = Array.from(hashBuffer.data);
  const phash = dctHash(gray, hashBuffer.info.width, hashBuffer.info.height);

  const sample = await image
    .clone()
    .resize({ width: 96, height: 96, fit: "inside" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const luma = [];
  for (let i = 0; i < sample.data.length; i += sample.info.channels) {
    luma.push(
      grayscaleLuma(sample.data[i], sample.data[i + 1], sample.data[i + 2]),
    );
  }
  const sky = skyExposure(luma, sample.info.width, sample.info.height);
  const avg = mean(luma);
  let gradient = 0;
  const sw = sample.info.width;
  for (let y = 0; y < sample.info.height; y += 1) {
    for (let x = 0; x < sw - 1; x += 1)
      gradient += Math.abs(luma[y * sw + x + 1] - luma[y * sw + x]);
  }
  const sharpness = gradient / Math.max(1, luma.length);
  const clippedHigh = luma.filter((value) => value >= 250).length / luma.length;
  const clippedLow = luma.filter((value) => value <= 5).length / luma.length;
  const midtoneFraction = luma.filter((value) => value >= 24 && value <= 232).length / luma.length;
  const dimensions = {
    width: resolutionVerified
      ? metadata.width || record.width || 0
      : record.width || metadata.width || 0,
    height: resolutionVerified
      ? metadata.height || record.height || 0
      : record.height || metadata.height || 0,
  };
  const qualityFlags = [];
  if (sharpness < 3) qualityFlags.push("possibly-blurry");
  // Exposure gates combine scene and measured face later; do not stamp a
  // bright background or dark night scene as a permanent rejection flag.
  if (resolutionVerified && Math.min(dimensions.width, dimensions.height) < 800)
    qualityFlags.push("low-resolution");
  const quality = scoreQuality({
    sharpness,
    clippedHigh,
    clippedLow,
    resolutionVerified,
    ...dimensions,
  });
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
      skyExposure: sky,
      technicalDetail: await measureTechnicalDetail(analysisPath),
      meanLuma: Math.round(avg * 100) / 100,
      lumaVariance: Math.round(variance(luma, avg) * 100) / 100,
      sharpness: Math.round(sharpness * 1000) / 1000,
      clippedHigh: Math.round(clippedHigh * 10000) / 10000,
      clippedLow: Math.round(clippedLow * 10000) / 10000,
      midtoneFraction: Math.round(midtoneFraction * 10000) / 10000,
      exposureSuitability: Math.round(exposureSuitability({ meanLuma: avg,
        clippedHigh: sky?.subject.clippedHigh ?? clippedHigh, clippedLow, midtoneFraction }) * 10000) / 10000,
      quality: quality / 100,
      aesthetic: null,
      compositionScore: null,
      subjectScore: null,
    },
    qualityScore: scoreQuality({
      sharpness,
      clippedHigh,
      clippedLow,
      resolutionVerified,
      ...dimensions,
    }),
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
  if (!face || face.available === false || face.error)
    return {
      ...item,
      face: { ...face, available: false, eyeAssessment: "unavailable" },
    };
  const count = Number.isSafeInteger(face.faceCount)
    ? face.faceCount
    : (face.faces || []).length;
  const closedEyes = (face?.faces || []).some((entry) => entry.eyesClosed);
  const eyeAssessment = closedEyes
    ? "possible-closed"
    : !count
      ? "not-detected"
      : (face.faces || []).length < count ||
          (face.faces || []).some((entry) => entry.eyesAssessed === false)
        ? "incomplete"
        : "no-closed-signal";
  face = { ...face, eyeAssessment };
  if (!closedEyes) return { ...item, face };
  const qualityFlags = [
    ...new Set([...(item.qualityFlags || []), "eyes-closed"]),
  ];
  return {
    ...item,
    face,
    qualityFlags,
    qualityScore:
      Math.round(Math.max(0, (item.qualityScore || 0) - 25) * 100) / 100,
    confidence: null,
    confidenceCalibrated: false,
  };
}

export function clusterByPhash(items, threshold = 8) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64)
    throw new Error("pHash threshold must be an integer from 0 to 64");
  const popcount = (value) => {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const prepared = items
    .map((item) => {
      const valid =
        typeof item.phash === "string" && /^[01]{1,64}$/.test(item.phash);
      return {
        item,
        length: valid ? item.phash.length : 0,
        high: valid ? parseInt(item.phash.slice(0, 32), 2) : 0,
        low:
          valid && item.phash.length > 32
            ? parseInt(item.phash.slice(32), 2)
            : 0,
        sha:
          typeof item.sha256 === "string" && /^[a-f\d]{64}$/i.test(item.sha256)
            ? item.sha256.toLowerCase()
            : null,
      };
    })
    .sort(
      (a, b) =>
        (Number.isFinite(b.item.qualityScore) ? b.item.qualityScore : 0) -
          (Number.isFinite(a.item.qualityScore) ? a.item.qualityScore : 0) ||
        String(a.item.id).localeCompare(String(b.item.id)),
    );
  const distance = (a, b) =>
    a.sha && a.sha === b.sha
      ? 0
      : a.length && a.length === b.length
        ? popcount(a.high ^ b.high) + popcount(a.low ^ b.low)
        : Infinity;
  // Quality-first deterministic complete-link partition: every pair in a group
  // must satisfy the threshold, not merely be connected by an intermediate shot.
  const groups = [];
  for (const candidate of prepared) {
    let group = null;
    for (const existing of groups) {
      if (distance(candidate, existing.members[0]) > threshold) continue;
      if (
        existing.members.every(
          (member) => distance(candidate, member) <= threshold,
        )
      ) {
        group = existing;
        break;
      }
    }
    if (group) group.members.push(candidate);
    else groups.push({ members: [candidate] });
  }
  return groups.map(({ members }, index) => ({
    groupId: `phash-${String(index + 1).padStart(4, "0")}`,
    size: members.length,
    representativeId: members[0].item.id,
    similarityMethod: "phash-pairwise-v2",
    phashThreshold: threshold,
    items: members.map((member) => ({
      ...member.item,
      phashDistance: distance(member, members[0]),
    })),
  }));
}

export function normalizeMetrics(metrics = {}, { sharpnessScale } = {}) {
  const clamp = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const sharpness = Number.isFinite(metrics.sharpness)
    ? Math.max(
        0,
        Math.min(
          1,
          sharpnessScale ? metrics.sharpness / sharpnessScale :
            metrics.sharpness > 1 ? metrics.sharpness / 100 : metrics.sharpness,
        ),
      )
    : null;
  const exposure = Number.isFinite(metrics.exposureSuitability)
    ? Math.max(0, Math.min(1, metrics.exposureSuitability))
    : Number.isFinite(metrics.exposure)
      ? Math.max(0, Math.min(1, metrics.exposure))
      : Number.isFinite(metrics.meanLuma)
        ? exposureSuitability(metrics)
        : null;
  return {
    sharpness,
    exposure,
    clippedHighlights: clamp(metrics.clippedHigh ?? metrics.clippedHighlights),
    clippedShadows: clamp(metrics.clippedLow ?? metrics.clippedShadows),
    faces: Number.isFinite(metrics.faces) ? metrics.faces : null,
    eyesClosed: Number.isFinite(metrics.eyesClosed) ? metrics.eyesClosed : null,
    quality: clamp(metrics.quality),
    aesthetic: clamp(metrics.aesthetic),
    raw: {
      ...(metrics.skyExposure ? { skyExposure: metrics.skyExposure } : {}),
      ...(metrics.technicalDetail ? { technicalDetail: metrics.technicalDetail } : {}),
      meanLuma: metrics.meanLuma ?? null,
      lumaVariance: metrics.lumaVariance ?? null,
      midtoneFraction: metrics.midtoneFraction ?? null,
      previewSharpness: sharpnessScale ? metrics.sharpness ?? null : null,
    },
  };
}
