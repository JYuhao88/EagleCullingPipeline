// Offline finalizer for legacy tool-owned custom thumbnails. Run only with Eagle closed.
// It backs up each thumbnail before removing the custom-thumbnail file; Eagle regenerates
// the native preview when the library is opened again. Originals and metadata.json remain untouched.
import { cp, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const libraryPath = process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library";
const backupRoot = process.env.EAGLE_THUMBNAIL_BACKUP || "D:/Photography/EagleThumbnailBackups/pre-native-refresh";
if (process.env.RESTORE_OFFLINE_CONFIRM !== "I_UNDERSTAND") throw new Error("Offline thumbnail removal is disabled by default; set RESTORE_OFFLINE_CONFIRM=I_UNDERSTAND only after a tested backup");
const inventory = JSON.parse(await readFile(path.join(root, "data/thumbnail-badges.json"), "utf8"));
const entries = inventory.items || inventory.entries || inventory;
const registered = (Array.isArray(entries) ? entries : Object.values(entries)).filter((x) => x && !x.skipped && x.outputPath);
const eagle = (await import("node:child_process")).execFileSync("powershell.exe", ["-NoProfile", "-Command", "@(Get-Process Eagle -ErrorAction SilentlyContinue).Count"], { encoding: "utf8" }).trim();
if (Number(eagle) > 0) throw new Error("Eagle is still running; close it before offline thumbnail restoration");
const results = [];
for (const entry of registered) {
  const id = entry.id || entry.itemId || entry.badgeKey;
  const infoDir = path.join(libraryPath, "images", `${id}.info`);
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(infoDir, "metadata.json"), "utf8")); } catch { results.push({ id, status: "skipped", reason: "metadata-missing" }); continue; }
  if (metadata.customThumbnail !== true) { results.push({ id, status: "skipped", reason: "not-custom-thumbnail" }); continue; }
  const files = await readdir(infoDir);
  const thumbnailName = files.find((name) => name.toLowerCase().endsWith("_thumbnail.png"));
  if (!thumbnailName) { results.push({ id, status: "skipped", reason: "thumbnail-missing" }); continue; }
  const source = path.join(infoDir, thumbnailName);
  const backup = path.join(backupRoot, `${id}_${thumbnailName}`);
  await mkdir(path.dirname(backup), { recursive: true });
  try { await cp(source, backup, { force: false }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  await unlink(source);
  results.push({ id, status: "removed", source, backup, bytes: (await stat(backup)).size });
}
const report = { createdAt: new Date().toISOString(), libraryPath, registeredCount: registered.length, removed: results.filter((x) => x.status === "removed").length, skipped: results.filter((x) => x.status === "skipped").length, results };
const reportPath = path.join(root, "data", `offline-native-refresh-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ reportPath, registeredCount: registered.length, removed: report.removed, skipped: report.skipped }, null, 2));
