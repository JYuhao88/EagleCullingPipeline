import { mkdir, stat, rename, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

export const MODEL_PREVIEW_VERSION = "jpeg-model-preview-1600-v1";

export class ModelPreviewCache {
  constructor(root=path.resolve("data/cache/model-previews")) {this.root=path.resolve(root);this.pending=new Map();}
  async prepare(item) {
    const fallback=item.analysisPath || item.thumbnailPath;
    const ext=String(item.ext || path.extname(item.filePath || "")).toLowerCase().replace(/^\./,"");
    if (!["jpg","jpeg"].includes(ext)) return {path:fallback,source:"existing-preview",reason:"仅为 JPEG 原片生成独立模型预览；其他格式保留现有预览"};
    try {
      const original=await stat(item.filePath);
      if (!original.isFile() || original.size > 1024**3) throw new Error("JPEG source is unavailable or too large");
      const key=crypto.createHash("sha256").update(JSON.stringify([MODEL_PREVIEW_VERSION,path.resolve(item.filePath),original.size,original.mtimeMs])).digest("hex");
      if (!this.pending.has(key)) {
        const promise=this.generate(item.filePath,key,original).finally(()=>this.pending.delete(key));
        this.pending.set(key,promise);
      }
      return await this.pending.get(key);
    } catch(error) {return {path:fallback,source:"existing-preview",reason:`原片模型预览不可用，保留现有预览：${error.message}`};}
  }
  async generate(source,key,before) {
    await mkdir(this.root,{recursive:true});
    const target=path.join(this.root,`${key}.jpg`);
    try {
      const metadata=await sharp(target).metadata();
      if(metadata.format === "jpeg" && metadata.width <= 1600 && metadata.height <= 1600) return {path:target,source:"jpeg-original-preview",version:MODEL_PREVIEW_VERSION,width:metadata.width,height:metadata.height,cached:true};
    } catch { /* missing/invalid tool cache is regenerated, never the source */ }
    const input=sharp(source,{limitInputPixels:150_000_000,sequentialRead:true});
    const metadata=await input.metadata();
    if(metadata.format !== "jpeg") throw new Error("Source is not a JPEG image");
    const temporary=path.join(this.root,`${key}.${crypto.randomUUID()}.tmp.jpg`);
    try {
      const output=await input.rotate().resize({width:1600,height:1600,fit:"inside",withoutEnlargement:true}).jpeg({quality:90}).toFile(temporary);
      const after=await stat(source);
      if(after.size!==before.size || after.mtimeMs!==before.mtimeMs) throw new Error("Source changed during model preview generation");
      await rename(temporary,target);
      return {path:target,source:"jpeg-original-preview",version:MODEL_PREVIEW_VERSION,width:output.width,height:output.height,cached:false};
    } finally {await rm(temporary,{force:true});}
  }
}
