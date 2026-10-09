// Replace tool-owned thumbnails with clean previews through Eagle Web API V2.
// Originals and human metadata are never written.
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const libraryPath = process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library";
const api = process.env.EAGLE_API_BASE || "http://127.0.0.1:41595/api/v2";
const outputRoot = path.join(root, "data", "clean-thumbnails");
const limit = Number(process.env.CLEAN_THUMBNAIL_LIMIT || 0);
const nameFilter = process.env.CLEAN_THUMBNAIL_NAME || "";
const concurrency = Math.max(1, Math.min(4, Number(process.env.CLEAN_THUMBNAIL_CONCURRENCY || 2)));
const request = async (endpoint, options = {}) => { const r = await fetch(`${api}/${endpoint}`, { ...options, signal: AbortSignal.timeout(30000) }); const p = await r.json().catch(() => ({})); if (!r.ok || p.status !== "success") throw new Error(p.message || `Eagle HTTP ${r.status}`); return p.data; };
const filesFor = async (id) => readdir(path.join(libraryPath, "images", `${id}.info`));
const sourceFor = async (item, allItems) => {
  const dir = path.join(libraryPath, "images", `${item.id}.info`); const names = await filesFor(item.id); const ext = String(item.ext).toLowerCase();
  let source = ["jpg", "jpeg", "heic", "png", "webp"].includes(ext) ? names.find((n) => n.toLowerCase().endsWith(`.${ext}`)) : null;
  if (!source && ["3fr", "dng", "arw", "nef", "cr3"].includes(ext)) {
    const pair = allItems.find((candidate) => candidate.name === item.name && ["jpg", "jpeg", "heic"].includes(String(candidate.ext).toLowerCase()));
    if (pair) { const pairDir = path.join(libraryPath, "images", `${pair.id}.info`); const pairNames = await readdir(pairDir); const pairSource = pairNames.find((n) => n.toLowerCase().endsWith(`.${String(pair.ext).toLowerCase()}`)); if (pairSource) return path.join(pairDir, pairSource); }
  }
  if (!source) throw new Error(`无可解码预览：${item.name}.${ext}`);
  return path.join(dir, source);
};
const makePreview = async (item, allItems) => { const input = await sourceFor(item, allItems); const output = path.join(outputRoot, `${item.id}.png`); await mkdir(outputRoot, { recursive: true }); await sharp(input, { failOn: "none" }).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toFile(output); return output; };
const info = await request("library/info"); if (path.resolve(info.path) !== path.resolve(libraryPath)) throw new Error(`Library mismatch: ${info.path}`);
const manifest = JSON.parse(await readFile(path.join(root, "data/thumbnail-badges.json"), "utf8")); const entries = manifest.items || manifest.entries || manifest; const registered = new Set((Array.isArray(entries) ? entries : Object.values(entries)).filter((x) => x && !x.skipped && x.outputPath).map((x) => x.id || x.itemId || x.badgeKey));
const all = []; let offset = 0; while (true) { const page = await request(`item/get?offset=${offset}&limit=500`); all.push(...(page.data || [])); offset += page.data?.length || 0; if (!page.data?.length || offset >= page.total) break; }
const onlyIds = new Set(String(process.env.CLEAN_THUMBNAIL_ONLY_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
let candidates = all.filter((item) => registered.has(item.id) && item.customThumbnail === true && (!nameFilter || item.name === nameFilter) && (!onlyIds.size || onlyIds.has(item.id))); if (limit > 0) candidates = candidates.slice(0, limit);
const results = []; let next = 0; async function worker() { while (true) { const index = next++; if (index >= candidates.length) return; const item = candidates[index]; try { const outputPath = await makePreview(item, all); await request("item/setCustomThumbnail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: item.id, filePath: outputPath }) }); results[index] = { id: item.id, name: item.name, ext: item.ext, status: "succeeded", outputPath }; } catch (error) { results[index] = { id: item.id, name: item.name, ext: item.ext, status: "failed", error: error.message }; } } }
await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
const report = { createdAt: new Date().toISOString(), libraryPath, candidateCount: candidates.length, concurrency, results }; const reportPath = path.join(root, "data", `clean-thumbnail-${Date.now()}.json`); const { writeFile } = await import("node:fs/promises"); await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8"); console.log(JSON.stringify({ reportPath, candidateCount: candidates.length, succeeded: results.filter((x) => x.status === "succeeded").length, failed: results.filter((x) => x.status === "failed").length }, null, 2));
