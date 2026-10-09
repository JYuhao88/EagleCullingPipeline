// Restore only tool-registered custom thumbnails through Eagle Web API V2.
// Never edits Eagle's internal files in place; every current thumbnail is copied
// to an external backup before refreshThumbnail is requested.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const libraryPath = process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library";
const apiBase = process.env.EAGLE_API_BASE || "http://127.0.0.1:41595/api/v2";
const backupRoot = process.env.EAGLE_THUMBNAIL_BACKUP || "D:/Photography/EagleThumbnailBackups/pre-native-refresh";
const limit = Number(process.env.RESTORE_LIMIT || 0);
const concurrency = Math.max(1, Math.min(4, Number(process.env.RESTORE_CONCURRENCY || 2)));

async function request(endpoint, options = {}) {
  const response = await fetch(`${apiBase}/${endpoint}`, { ...options, signal: AbortSignal.timeout(30000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "success") throw new Error(payload.message || `Eagle HTTP ${response.status}`);
  return payload.data;
}
async function sha256(file) { const h = createHash("sha256"); h.update(await readFile(file)); return h.digest("hex"); }
async function listItems() {
  const result = []; let offset = 0;
  while (true) {
    const page = await request(`item/get?offset=${offset}&limit=500`);
    result.push(...(page.data || [])); offset += page.data?.length || 0;
    if (!page.data?.length || offset >= page.total) return result;
  }
}
async function processOne(item) {
  const info = path.join(libraryPath, "images", `${item.id}.info`);
  const names = await readdir(info);
  const thumbnailName = names.find((name) => name.toLowerCase().endsWith("_thumbnail.png"));
  if (!thumbnailName) return { id: item.id, status: "skipped", reason: "thumbnail-missing" };
  const source = path.join(info, thumbnailName);
  const backup = path.join(backupRoot, `${item.id}_${thumbnailName}`);
  await mkdir(path.dirname(backup), { recursive: true });
  await cp(source, backup, { force: false }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const beforeSha256 = await sha256(source);
  await request("item/refreshThumbnail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: item.id }) });
  let after = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = (await request(`item/get?id=${encodeURIComponent(item.id)}`)).data?.[0];
    if (after && after.customThumbnail === false) break;
  }
  const afterSha256 = await sha256(source).catch(() => null);
  return { id: item.id, name: item.name, ext: item.ext, status: after?.customThumbnail === false ? "succeeded" : "uncertain", beforeSha256, afterSha256, customThumbnail: after?.customThumbnail ?? null };
}

const info = await request("library/info");
if (path.resolve(info.path) !== path.resolve(libraryPath)) throw new Error(`Library mismatch: ${info.path}`);
const manifest = JSON.parse(await readFile(path.join(root, "data/thumbnail-badges.json"), "utf8"));
const entries = manifest.items || manifest.entries || manifest;
const registered = new Set((Array.isArray(entries) ? entries : Object.values(entries)).filter((x) => x && !x.skipped && x.outputPath).map((x) => x.id || x.itemId || x.badgeKey));
const candidates = (await listItems()).filter((item) => registered.has(item.id) && item.customThumbnail === true);
const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
const results = []; let next = 0;
async function worker() { while (true) { const index = next++; if (index >= selected.length) return; try { results[index] = await processOne(selected[index]); } catch (error) { results[index] = { id: selected[index].id, name: selected[index].name, status: "failed", error: error.message }; } } }
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
const report = { createdAt: new Date().toISOString(), libraryPath, candidateCount: candidates.length, selectedCount: selected.length, concurrency, results };
const reportPath = path.join(root, "data", `native-refresh-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ reportPath, candidateCount: candidates.length, selectedCount: selected.length, succeeded: results.filter((x) => x.status === "succeeded").length, uncertain: results.filter((x) => x.status === "uncertain").length, failed: results.filter((x) => x.status === "failed").length }, null, 2));
