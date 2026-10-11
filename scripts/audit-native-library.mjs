/**
 * Read-only post-migration audit for the active Eagle library.
 * It verifies that active photo items use Eagle-native thumbnails and that
 * the generated thumbnail orientation agrees with Eagle's stored dimensions.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const api = process.env.EAGLE_API_BASE || "http://127.0.0.1:41595/api/v2";
const library = process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library";
const imageRoot = path.join(library, "images");
const photoExts = new Set(["jpg", "jpeg", "heic", "arw", "dng", "3fr"]);

async function request(endpoint) {
  const response = await fetch(`${api}/${endpoint}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
}

async function allItems() {
  const result = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = (await request(`item/get?offset=${offset}&limit=1000`)).data || {};
    result.push(...(page.data || []));
    total = Number(page.total || result.length);
    if (!(page.data || []).length) break;
    offset += page.data.length;
  }
  return result.filter((item) => !item.isDeleted);
}

const items = await allItems();
const photos = items.filter((item) => photoExts.has(String(item.ext || "").toLowerCase()));
const custom = photos.filter((item) => item.customThumbnail === true);
const missing = [];
const orientationMismatches = [];
const orientation = (width, height) => width === height ? "square" : width > height ? "landscape" : "portrait";

for (const item of photos) {
  const dir = path.join(imageRoot, `${item.id}.info`);
  if (!fs.existsSync(dir)) {
    missing.push({ id: item.id, name: item.name, reason: "missing .info directory" });
    continue;
  }
  const thumb = fs.readdirSync(dir).find((name) => /_thumbnail\./i.test(name));
  if (!thumb) {
    missing.push({ id: item.id, name: item.name, reason: "missing native thumbnail" });
    continue;
  }
  try {
    const metadata = await sharp(path.join(dir, thumb)).metadata();
    if (orientation(item.width, item.height) !== orientation(metadata.width, metadata.height)) {
      orientationMismatches.push({
        id: item.id,
        name: item.name,
        item: [item.width, item.height],
        thumbnail: [metadata.width, metadata.height],
      });
    }
  } catch (error) {
    missing.push({ id: item.id, name: item.name, reason: error.message });
  }
}

const result = {
  library,
  activeItems: items.length,
  activePhotos: photos.length,
  customThumbnailCount: custom.length,
  missingNativeThumbnailCount: missing.length,
  orientationMismatchCount: orientationMismatches.length,
  customThumbnailSample: custom.slice(0, 20).map(({ id, name, ext }) => ({ id, name, ext })),
  missingSample: missing.slice(0, 20),
  orientationMismatchSample: orientationMismatches.slice(0, 20),
  passed: custom.length === 0 && missing.length === 0 && orientationMismatches.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
