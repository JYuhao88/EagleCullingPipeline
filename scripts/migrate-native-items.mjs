// Migrate custom-thumbnail photo items to native Eagle items.
// New item is imported and verified before the old item is moved to trash.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const libraryPath =
  process.env.EAGLE_LIBRARY_PATH ||
  (() => {
    throw new Error("Set EAGLE_LIBRARY_PATH");
  })();
const api = process.env.EAGLE_API_BASE || "http://127.0.0.1:41595/api/v2";
const concurrency = Math.max(1, Math.min(4, Number(process.env.MIGRATION_CONCURRENCY || 2)));
const limit = Math.max(0, Number(process.env.MIGRATION_LIMIT || 0));
const reportPath = path.resolve(root, "data/native-migration.json");
const extensions = new Set(["jpg", "jpeg", "dng", "heic", "3fr", "arw"]);
const requestedExtensions = new Set(
  String(process.env.MIGRATION_EXTENSIONS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean),
);

async function request(endpoint, options = {}) {
  const response = await fetch(`${api}/${endpoint}`, { ...options, signal: AbortSignal.timeout(60000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "success") throw new Error(payload.message || `Eagle HTTP ${response.status}`);
  return payload.data;
}
async function allItems() {
  const result = [];
  let offset = 0;
  while (true) {
    const page = await request(`item/get?offset=${offset}&limit=1000`);
    result.push(...(page.data || []));
    offset += page.data?.length || 0;
    if (!page.data?.length || offset >= page.total) return result;
  }
}
async function sourcePath(item) {
  const dir = path.join(libraryPath, "images", `${item.id}.info`);
  const names = await readdir(dir);
  const ext = String(item.ext).toLowerCase();
  const source = names.find((name) => name.toLowerCase().endsWith(`.${ext}`));
  if (!source) throw new Error(`原片文件不存在：${item.name}.${ext}`);
  return path.join(dir, source);
}
async function migrate(item) {
  const pathToSource = await sourcePath(item);
  const body = {
    path: pathToSource,
    name: item.name,
    tags: item.tags || [],
    folders: item.folders || [],
    annotation: item.annotation || "",
  };
  if (item.url) body.website = item.url;
  const added = await request("item/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const newId = added.id;
  if (!newId) throw new Error("导入未返回新项目 ID");
  let imported;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    imported = (await request(`item/get?id=${encodeURIComponent(newId)}`)).data?.[0];
    if (imported && imported.customThumbnail !== true && imported.width && imported.height) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (
    !imported ||
    imported.isDeleted ||
    imported.ext.toLowerCase() !== item.ext.toLowerCase() ||
    !imported.width ||
    !imported.height ||
    imported.customThumbnail === true
  )
    throw new Error(
      `新项目验证失败：${newId} ${JSON.stringify({
        oldExt: item.ext, newExt: imported?.ext, width: imported?.width, height: imported?.height,
        customThumbnail: imported?.customThumbnail, isDeleted: imported?.isDeleted,
      })}`,
    );
  const metadata = { id: newId, tags: item.tags || [], folders: item.folders || [], annotation: item.annotation || "" };
  if (Number.isInteger(item.star)) metadata.star = item.star;
  await request("item/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  await request("item/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: item.id, isDeleted: true }),
  });
  return {
    oldId: item.id,
    newId,
    name: item.name,
    ext: item.ext,
    oldSize: item.size,
    width: imported.width,
    height: imported.height,
    status: "migrated",
  };
}

const library = await request("library/info");
if (path.resolve(library.path) !== path.resolve(libraryPath)) throw new Error(`资源库不匹配：${library.path}`);
let report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  libraryPath,
  concurrency,
  results: [],
};
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch {
  /* first run */
}
report.results = report.results.filter(Boolean);
const done = new Set(report.results.filter((x) => x.status === "migrated").map((x) => x.oldId));
let candidates = (await allItems()).filter(
  (item) =>
    !item.isDeleted &&
    item.customThumbnail === true &&
    extensions.has(String(item.ext).toLowerCase()) &&
    (!requestedExtensions.size || requestedExtensions.has(String(item.ext).toLowerCase())) &&
    !done.has(item.id),
);
if (limit > 0) candidates = candidates.slice(0, limit);
let cursor = 0;
const results = [];
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= candidates.length) return;
    const item = candidates[index];
    try {
      results[index] = await migrate(item);
    } catch (error) {
      results[index] = { oldId: item.id, name: item.name, ext: item.ext, status: "failed", error: error.message };
    }
    if ((index + 1) % 10 === 0) {
      report.results.push(...results.splice(0));
      report.updatedAt = new Date().toISOString();
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
report.results.push(...results.filter(Boolean));
report.updatedAt = new Date().toISOString();
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      reportPath,
      selected: candidates.length,
      migrated: results.filter((x) => x?.status === "migrated").length,
      failed: results.filter((x) => x?.status === "failed").length,
      totalMigrated: report.results.filter((x) => x.status === "migrated").length,
    },
    null,
    2,
  ),
);
