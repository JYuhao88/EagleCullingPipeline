import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import sharp from "sharp";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
export const SCORER_MODEL = "topiq-nr-onnx";
export const SCORER_VERSION = "topiq-nr-512-v1";
export const SCORER_CACHE_KEY = `${SCORER_MODEL}:${SCORER_VERSION}:${process.env.EAGLE_SCORER_PROVIDER || "cpu"}`;
export const EXPECTED_SHA256 = Object.freeze({
  "topiq_nr_512.onnx": "bc1f59ca097afadb7c9343fa370d0fe47b0cfe5e21b623957f597a6f2bea08eb",
  "topiq_nr_512.onnx.data": "0ab4e4c4da5eb6461357379178e96b06ebfc11105a02c0854598d56b910b2582",
});
const sessions = new Map();
const modelValidation = new Map();
function modelPath(root) {
  return path.join(root, "models", "scorer", "topiq_nr_512.onnx");
}
function dataPath(root) {
  return path.join(root, "models", "scorer", "topiq_nr_512.onnx.data");
}
async function sha256(file) {
  const digest = crypto.createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex");
}
async function validateModels(root) {
  if (!modelValidation.has(root)) {
    modelValidation.set(root, (async () => {
      const files = [modelPath(root), dataPath(root)];
      const warnings = [];
      for (const file of files) {
        const name = path.basename(file);
        let actual = "不存在";
        try {
          actual = await sha256(file);
        } catch {}
        if (actual !== EXPECTED_SHA256[name]) {
          warnings.push(
            `TOPIQ-NR 模型校验失败：${name} 期望 ${EXPECTED_SHA256[name].slice(0, 12)}，实际 ${actual.slice(0, 12)}`,
          );
        }
      }
      return { valid: warnings.length === 0, warning: warnings.join("；") };
    })());
  }
  return modelValidation.get(root);
}
async function getSession(model) {
  const provider = process.env.EAGLE_SCORER_PROVIDER || 'cpu';
  const key = `${model}:${provider}`;
  if (!sessions.has(key)) {
    const options = {
      intraOpNumThreads: Math.min(3, Math.max(1, Number(process.env.EAGLE_SCORER_THREADS || 3))),
    };
    // Explicit provider requests must fail visibly rather than silently become CPU runs.
    if (process.env.EAGLE_SCORER_PROVIDER) options.executionProviders = [provider];
    if (provider === 'dml') { options.enableMemPattern = false; options.executionMode = 'sequential'; }
    sessions.set(key, ort.InferenceSession.create(model, options));
  }
  return sessions.get(key);
}
async function tensorFor(filePath) {
  const { data } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(512, 512, { fit: "fill", kernel: sharp.kernel.bilinear })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = 512 * 512;
  const input = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index += 1) {
    input[index] = data[index * 3] / 255;
    input[plane + index] = data[index * 3 + 1] / 255;
    input[2 * plane + index] = data[index * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", input, [1, 3, 512, 512]);
}
export async function score(
  previewPaths,
  { root = process.cwd(), onTiming, signal } = {},
) {
  signal?.throwIfAborted();
  const model = modelPath(root);
  const validation = await validateModels(root);
  let session;
  let warning = validation.warning || undefined;
  if (validation.valid && previewPaths.some(Boolean)) {
    try {
      session = await getSession(model);
    } catch (error) {
      warning = `TOPIQ-NR ONNX 加载失败：${error.message}`;
    }
  }
  const results = [];
  for (let index = 0; index < previewPaths.length; index += 1) {
    signal?.throwIfAborted();
    if (!session || !previewPaths[index]) {
      results.push({
        quality: null,
        aesthetic: null,
        model: "unavailable",
        version: SCORER_VERSION,
        calibrated: false,
        warning: warning || "TOPIQ-NR 模型不可用",
      });
      continue;
    }
    try {
      const decodeStarted = performance.now();
      const input = await tensorFor(previewPaths[index]);
      const decodeMilliseconds = performance.now() - decodeStarted;
      signal?.throwIfAborted();
      const inferenceStarted = performance.now();
      const output = await session.run({ [session.inputNames[0]]: input });
      signal?.throwIfAborted();
      onTiming?.({
        index,
        decodeMilliseconds,
        inferenceMilliseconds: performance.now() - inferenceStarted,
      });
      const value = Number(
        output.score?.data?.[0] ?? output[session.outputNames[0]]?.data?.[0],
      );
      results.push({
        quality: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null,
        aesthetic: null,
        model: SCORER_MODEL,
        version: SCORER_VERSION,
        calibrated: true,
      });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({
        quality: null,
        aesthetic: null,
        model: "unavailable",
        version: SCORER_VERSION,
        calibrated: false,
        warning: `TOPIQ-NR 推理失败：${error.message}`,
      });
    }
  }
  return results;
}
