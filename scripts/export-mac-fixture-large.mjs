import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const libraryPath = process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library";
const outputPath = path.resolve(root, process.env.MAC_FIXTURE_OUTPUT || "exports/mac-fixture-v3");
const selectedNames = new Set([
  ...Array.from({ length: 34 }, (_, index) => `R001${1300 + index}`),
  "B0006942", "B0006943", "B0006944", "B0006945", "B0006937", "B0006936", "B0006935", "B0006934", "B0006933", "B0006932", "B0006931", "B0006929",
]);
const imageExtensions = new Set(["jpg", "dng", "heic", "3fr"]);
const hash = async (file) => { const h = createHash("sha256"); h.update(await readFile(file)); return h.digest("hex"); };
const inventory = JSON.parse(await readFile(path.join(root, "data/inventory.json"), "utf8"));
const records = inventory.items.filter((x) => selectedNames.has(x.name) && imageExtensions.has(String(x.ext).toLowerCase()));
if (records.length !== 92) throw new Error(`Expected 92 items, found ${records.length}`);
await mkdir(path.join(outputPath, "photos"), { recursive: true });
await mkdir(path.join(outputPath, "thumbnails"), { recursive: true });
const items = [];
for (const item of records.sort((a, b) => `${a.name}.${a.ext}`.localeCompare(`${b.name}.${b.ext}`))) {
  const ext = String(item.ext).toLowerCase();
  const info = path.join(libraryPath, "images", `${item.id}.info`);
  const names = await readdir(info);
  const source = names.find((name) => name.toLowerCase().endsWith(`.${ext}`));
  if (!source) throw new Error(`Missing source for ${item.id}`);
  const target = path.join(outputPath, "photos", `${item.name}.${ext}`);
  await cp(path.join(info, source), target);
  const thumbnail = names.find((name) => name.toLowerCase().endsWith("_thumbnail.png"));
  let thumbnailRelativePath = null;
  if (thumbnail) {
    const thumbTarget = path.join(outputPath, "thumbnails", `${item.name}.${ext}_thumbnail.png`);
    await cp(path.join(info, thumbnail), thumbTarget);
    thumbnailRelativePath = path.relative(outputPath, thumbTarget).replaceAll("\\", "/");
  }
  items.push({ id: item.id, name: item.name, ext, width: item.width, height: item.height, tags: item.tags || [], folders: item.folders || [], modificationTime: item.modificationTime, sourceRelativePath: path.relative(outputPath, target).replaceAll("\\", "/"), thumbnailRelativePath, size: (await stat(target)).size, sha256: await hash(target) });
}
const readme = [
  "# Mac 开发照片压测集", "", "共 46 个拍摄单元、92 个原始文件：",
  "- R0011300–R0011333：34 组连续 JPG/DNG，适合并发、相似组和重复筛选压测；",
  "- B0006929–B0006945：12 组 HEIC/3FR，覆盖 Windows 解码失败的 HEIC，验证 Mac 原生解码和哈苏 RAW/JPEG 配对；",
  "- thumbnails/保留 Eagle 当前缩略图，可验证历史左上角角标恢复；",
  "- manifest.json 含 ID、格式、标签、尺寸和 SHA-256。", "", "此目录是副本，不包含 Eagle 数据库，不会修改原资源库。"
].join("\n");
await writeFile(path.join(outputPath, "manifest.json"), JSON.stringify({ schemaVersion: 2, createdAt: new Date().toISOString(), sourceLibrary: libraryPath, itemCount: items.length, captureUnits: selectedNames.size, items }, null, 2), "utf8");
await writeFile(path.join(outputPath, "README.md"), readme, "utf8");
console.log(JSON.stringify({ outputPath, itemCount: items.length, bytes: items.reduce((n, x) => n + x.size, 0) }, null, 2));
