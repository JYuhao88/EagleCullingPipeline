import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import sharp from "sharp";

export function faceCropBox(box, width, height, padding = 0.35) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    return null;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Number.isFinite(padding) || padding < 0) {
    return null;
  }
  const [x0, y0, x1, y1] = box;
  if (x1 <= x0 || y1 <= y0) return null;
  const dx = (x1 - x0) * padding;
  const dy = (y1 - y0) * padding;
  const left = Math.max(0, Math.floor((x0 - dx) * width));
  const top = Math.max(0, Math.floor((y0 - dy) * height));
  const right = Math.min(width, Math.ceil((x1 + dx) * width));
  const bottom = Math.min(height, Math.ceil((y1 + dy) * height));
  return { left, top, width: right - left, height: bottom - top };
}

const pendingFaces = new Map();

export async function faceImage(store, id, unitId, faceIndex, state, detailImage) {
  const key = path.join(store.dir(id), "face", `${encodeURIComponent(unitId)}-${faceIndex}.jpg`);
  if (!pendingFaces.has(key)) {
    const pending = createFaceImage(store, id, unitId, faceIndex, state, detailImage).finally(() => pendingFaces.delete(key));
    pendingFaces.set(key, pending);
  }
  return pendingFaces.get(key);
}

async function createFaceImage(store, id, unitId, faceIndex, state, detailImage) {
  const result = state.results?.find(entry => entry.unitId === unitId);
  const face = result?.faces?.[faceIndex];
  if (!faceCropBox(face?.box, 1, 1)) return null;
  const file = path.join(store.dir(id), "face", `${encodeURIComponent(unitId)}-${faceIndex}.jpg`);
  try {
    await access(file);
    return file;
  } catch {
    const source = await detailImage(store, id, unitId, state);
    if (!source) return null;
    try {
      const { data, info } = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
      const crop = faceCropBox(face.box, info.width, info.height);
      if (!crop) return null;
      await mkdir(path.dirname(file), { recursive: true });
      await sharp(data).extract(crop).resize({
        width: 320, height: 320, fit: "inside", withoutEnlargement: true
      }).jpeg({ quality: 90 }).toFile(file);
      return file;
    } catch {
      return null;
    }
  }
}
