import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Backups live outside Eagle. Never write to or remove Eagle library files.
export class ThumbnailBackupStore {
  constructor(root = path.resolve("data", "thumbnail-backups")) {
    this.root = root;
    this.locks = new Map();
  }

  directory(libraryPath, itemId) {
    if (!libraryPath || !itemId) throw new Error("libraryPath and itemId are required");
    return path.join(this.root, digest(JSON.stringify([libraryPath, itemId])));
  }

  async get(libraryPath, itemId) {
    const directory = this.directory(libraryPath, itemId);
    let entry;
    try { entry = JSON.parse(await readFile(path.join(directory, "backup.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (entry.libraryPath !== libraryPath || entry.itemId !== itemId || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid thumbnail backup record");
    if (!/^\.(png|jpg|jpeg|webp|gif|tif|tiff)$/i.test(entry.extension || "")) throw new Error("Invalid backup image extension");
    const outputPath = path.join(directory, `original${entry.extension}`);
    if (digest(await readFile(outputPath)) !== entry.sha256) throw new Error("缩略图备份校验失败，未执行写回");
    return { ...entry, outputPath };
  }

  async prepare({ libraryPath, itemId, sourcePath, allowCapture }) {
    const directory = this.directory(libraryPath, itemId);
    const previous = this.locks.get(directory) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const existing = await this.get(libraryPath, itemId);
      if (existing) return existing;
      if (!allowCapture) throw new Error("历史角标没有干净备份，请明确重建原生缩略图后再生成角标");
      if (!sourcePath) throw new Error("Eagle 缩略图路径缺失；不使用原片作为备份");
      const extension = path.extname(sourcePath).toLowerCase();
      if (!/^\.(png|jpg|jpeg|webp|gif|tif|tiff)$/.test(extension)) throw new Error("仅备份 Eagle 图片缩略图，不读取 RAW 原片");
      const bytes = await readFile(sourcePath);
      if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("缩略图备份大小异常，未写入");
      const entry = { libraryPath, itemId, sha256: digest(bytes), extension, sourcePath, createdAt: new Date().toISOString() };
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `original${extension}`), bytes);
      const temporary = path.join(directory, "backup.json.tmp");
      await writeFile(temporary, JSON.stringify(entry), "utf8");
      await rename(temporary, path.join(directory, "backup.json"));
      return { ...entry, outputPath: path.join(directory, `original${extension}`) };
    });
    this.locks.set(directory, job);
    try { return await job; }
    finally { if (this.locks.get(directory) === job) this.locks.delete(directory); }
  }

  async matches(sourcePath, sha256) {
    if (!sourcePath || !/^[a-f0-9]{64}$/.test(sha256 || "")) return false;
    return digest(await readFile(sourcePath)) === sha256;
  }
}
