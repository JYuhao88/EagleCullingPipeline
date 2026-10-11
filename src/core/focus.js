import { localSetting } from './local-config.js';
import sharp from "sharp";
import { completeEyeRois } from "./eye-roi.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** Map a proxy (normalised 0..1) box to pixels in an orientation-normalised image. */
export function mapProxyBoxToNative(box, { width, height } = {}) {
  if (!Array.isArray(box) || box.length !== 4 || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const x0 = Math.max(0, Math.min(width, Math.round(box[0] * width)));
  const y0 = Math.max(0, Math.min(height, Math.round(box[1] * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(box[2] * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(box[3] * height)));
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, box: [x0 / width, y0 / height, x1 / width, y1 / height] };
}

function clampBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const b = box.map(Number);
  if (!b.every(Number.isFinite)) return null;
  const out = b.map(value => Math.max(0, Math.min(1, value)));
  return out[2] > out[0] && out[3] > out[1] ? out : null;
}

function eyeBoxes(face) {
  const explicit = face?.eyes || face?.eyeBoxes || (face?.eyeBox || face?.eyesBox ? [face.eyeBox || face.eyesBox] : null);
  if (Array.isArray(explicit)) return explicit.map((x) => clampBox(x?.box || x)).filter(Boolean);
  const b = clampBox(face?.box);
  if (!b) return [];
  // Face workers currently return a face rectangle only. Keep a conservative
  // upper-half ROI until keypoint eye boxes are available.
  const [x0, y0, x1, y1] = b, h = y1 - y0;
  return [[x0 + (x1 - x0) * .12, y0 + h * .22, x0 + (x1 - x0) * .46, y0 + h * .48],
    [x0 + (x1 - x0) * .54, y0 + h * .22, x0 + (x1 - x0) * .88, y0 + h * .48]];
}

/** Compute gradient and Laplacian variance from a grayscale raw crop. */
export async function focusMetrics(input) {
  const { data, info } = await sharp(input).rotate().resize({ width: 512, height: 512,
    fit: "inside", withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  if (w < 3 || h < 3) return { laplacianVariance: null, highFrequency: null, width: w, height: h };
  const lap = new Float64Array((w - 2) * (h - 2)); let sum = 0, sum2 = 0, grad = 0, n = 0;
  const px = (x, y) => data[y * w + x];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const v = 4 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1) - px(x, y + 1);
    lap[n++] = v; sum += v; sum2 += v * v;
    grad += Math.abs(px(x + 1, y) - px(x - 1, y)) + Math.abs(px(x, y + 1) - px(x, y - 1));
  }
  const mean = sum / n;
  return { laplacianVariance: Math.max(0, sum2 / n - mean * mean), highFrequency: grad / (2 * n * 255), width: w, height: h };
}

export function parseMakerFocus(metadata = {}) {
  const tags = metadata.exif || metadata;
  const value = (name) => tags[name] ?? tags[`EXIF:${name}`] ?? tags[`MakerNotes:${name}`];
  const parsePoint = (v, source) => {
    if (Array.isArray(v) && v.length >= 2) {
      const p = v.map(Number);
      return source === "FocusLocation" && p.length >= 4
        ? { point: p.slice(2, 4), coordinateSize: p.slice(0, 2) }
        : { point: p.slice(0, 2) };
    }
    if (typeof v === "string") {
      const p = (v.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      return source === "FocusLocation" && p.length >= 4
        ? { point: p.slice(2, 4), coordinateSize: p.slice(0, 2) }
        : { point: p.slice(0, 2) };
    }
    return null;
  };
  const pointSource = value("FocusLocation") != null ? "FocusLocation" : "AFAreas";
  if (pointSource === "AFAreas") return { point: null, coordinateSize: null, frameSize: null,
    mode: value("AFAreaMode") ?? null, source: null, naReason: "afareas-semantics-unverified" };
  const parsedPoint = parsePoint(value(pointSource), pointSource);
  const parsedSize = parsePoint(value("FocusFrameSize"), "FocusFrameSize");
  return { point: parsedPoint?.point?.every(Number.isFinite) ? parsedPoint.point : null,
    coordinateSize: parsedPoint?.coordinateSize?.every(Number.isFinite) ? parsedPoint.coordinateSize : null,
    frameSize: parsedSize?.point?.every(Number.isFinite) ? parsedSize.point : null,
    mode: value("AFAreaMode") ?? null, source: parsedPoint?.point ? pointSource : null };
}

export async function readMakerFocus(filePath) {
  if (!filePath) return { point: null, coordinateSize: null, frameSize: null, mode: null, source: null, naReason: "no-source" };
  try {
    const args = [...(process.platform === "win32" ? ["-charset", "filename=UTF8"] : []),
      "-j", "-n", "-FocusLocation", "-FocusFrameSize", "-AFAreaMode", "-AFAreas", filePath];
    const { stdout } = await execFileAsync(localSetting("EAGLE_EXIFTOOL", "exiftool"), args, { maxBuffer: 1024 * 1024 });
    const metadata = JSON.parse(stdout)?.[0] || {};
    const parsed = parseMakerFocus(metadata);
    return parsed.point ? parsed : { ...parsed, naReason: "maker-focus-unavailable" };
  } catch (error) {
    return { point: null, coordinateSize: null, frameSize: null, mode: null,
      source: null, naReason: `exiftool-unavailable:${error.code || "error"}` };
  }
}

function orientPoint(nx, ny, orientation) {
  if (orientation === 3) return [1 - nx, 1 - ny];
  if (orientation === 6) return [1 - ny, nx];
  if (orientation === 8) return [ny, 1 - nx];
  return [nx, ny];
}

function normPoint(point, width, height, orientation = 1, rawWidth = width, rawHeight = height, coordinateSize) {
  if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) return null;
  // Sony FocusLocation is commonly native pixels; some cameras use percentages
  // or signed offsets around frame centre.
  const [x, y] = point;
  const coordinateWidth = coordinateSize?.[0] || rawWidth;
  const coordinateHeight = coordinateSize?.[1] || rawHeight;
  if (coordinateWidth > 1 && coordinateHeight > 1 && x >= 0 && y >= 0
    && x <= coordinateWidth && y <= coordinateHeight) {
    return orientPoint(x / coordinateWidth, y / coordinateHeight, orientation);
  }
  return Math.abs(x) > 1 || Math.abs(y) > 1 ? [(x + 100) / 200, (y + 100) / 200] : [x, y];
}

function pointInBox(point, box) {
  return Boolean(point && box && point[0] >= box[0] && point[0] <= box[2]
    && point[1] >= box[1] && point[1] <= box[3]);
}

function boxesOverlap(a, b) {
  return Boolean(a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]);
}

function frameBox(makerFocus, orientation = 1) {
  const [x, y] = makerFocus.point, [w, h] = makerFocus.frameSize;
  const [cw, ch] = makerFocus.coordinateSize;
  const corners = [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2],
    [x - w / 2, y + h / 2], [x + w / 2, y + h / 2]]
    .map(([px, py]) => orientPoint(px / cw, py / ch, orientation));
  return [Math.max(0, Math.min(...corners.map(p => p[0]))), Math.max(0, Math.min(...corners.map(p => p[1]))),
    Math.min(1, Math.max(...corners.map(p => p[0]))), Math.min(1, Math.max(...corners.map(p => p[1])))];
}

/** Analyze native-resolution eye/face crops. Native source is decoded on demand. */
export async function analyzeFocus({ nativePath, nativeBuffer, proxySize, faces = [], persons = [],
  groupFocus = [], makerFocus, nativeSize } = {}) {
  const source = nativePath || nativeBuffer;
  if (!source) return { status: "na", naReason: "native-source-unavailable" };
  const rawMeta = nativeSize || await sharp(source).metadata();
  // sharp.rotate() applies EXIF orientation. Orientations 5..8 transpose the
  // axes, so expose dimensions in the same coordinate space as the crops.
  const transposed = !nativeSize && [5, 6, 7, 8].includes(rawMeta.orientation);
  const meta = { ...rawMeta, width: transposed ? rawMeta.height : rawMeta.width, height: transposed ? rawMeta.width : rawMeta.height };
  if (!meta.width || !meta.height) return { status: "na", naReason: "native-dimensions-unavailable" };
  faces = completeEyeRois(faces, persons);
  const all = [];
  for (const [faceIndex, face] of faces.entries()) {
    const fb = clampBox(face?.box); if (!fb) continue;
    const eyes = [];
    for (const eb of eyeBoxes(face)) {
      const crop = mapProxyBoxToNative(eb, meta); if (!crop) continue;
      const metrics = await focusMetrics(await sharp(source).rotate().extract(crop).jpeg().toBuffer());
      eyes.push({ proxyBox: eb, native: crop, ...metrics });
    }
    const faceCrop = mapProxyBoxToNative(fb, meta);
    const faceMetrics = faceCrop ? await focusMetrics(await sharp(source).rotate().extract(faceCrop).jpeg().toBuffer()) : {};
    all.push({ faceIndex, eyes, face: faceMetrics });
  }
  const eyeValues = all.flatMap((x) => x.eyes.map((e) => e.laplacianVariance)).filter(Number.isFinite);
  const eyeSharpnessNative = eyeValues.length ? eyeValues.reduce((a, b) => a + b, 0) / eyeValues.length : null;
  const groupValues = groupFocus.flatMap((x) => [x.eyeSharpnessNative, x.focus?.eyeSharpnessNative]).filter(Number.isFinite);
  const rank = eyeSharpnessNative == null ? null : 1 + groupValues.filter((v) => v > eyeSharpnessNative).length;
  const afPoint = normPoint(makerFocus?.point, meta.width, meta.height,
    nativeSize?.orientation, nativeSize?.rawWidth, nativeSize?.rawHeight, makerFocus?.coordinateSize);
  const afFrame = makerFocus?.frameSize && makerFocus?.coordinateSize
    ? frameBox(makerFocus, nativeSize?.orientation) : null;
  let afPointOnEye = null;
  if (afPoint && all.some(x => x.eyes.length)) afPointOnEye = all.some((x) => x.eyes.some((e) =>
    (afFrame ? boxesOverlap(afFrame, e.proxyBox) : pointInBox(afPoint, e.proxyBox))));
  const afPointOnSubject = afPoint && all.length ? all.some(x => afFrame
    ? boxesOverlap(afFrame, clampBox(faces[x.faceIndex]?.box))
    : pointInBox(afPoint, clampBox(faces[x.faceIndex]?.box))) : null;
  return { status: eyeSharpnessNative == null ? "na" : "ok", eyeSharpnessNative,
    faceSharpnessNative: all[0]?.face?.laplacianVariance ?? null,
    relativeRank: rank, confidence: eyeValues.length ? Math.min(1, eyeValues.length / 2) : 0,
    afPoint, afFrame, afPointOnSubject, afPointOnEye,
    afSource: makerFocus?.source || null, faces: all, naReason: eyeSharpnessNative == null ? "no-eye-roi" : null };
}
