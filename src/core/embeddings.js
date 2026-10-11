import { createRequire } from "node:module";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const mean = [0.485, 0.456, 0.406];
const std = [0.229, 0.224, 0.225];
let sessionPromise;

function modelPath(value) {
  return (
    value || process.env.EAGLE_DINO_MODEL || "models/dinov2-small/model.onnx"
  );
}

async function getSession(model) {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(model, {
      intraOpNumThreads: Number(process.env.EAGLE_DINO_THREADS || 2),
    });
  }
  return sessionPromise;
}

async function embedRaw(filePath, model, signal) {
  const { data } = await sharp(filePath)
    .resize(256, 256, { fit: "cover" })
    .extract({ left: 16, top: 16, width: 224, height: 224 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  const input = new Float32Array(3 * 224 * 224);
  for (let index = 0; index < 224 * 224; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      input[channel * 224 * 224 + index] =
        (data[index * 3 + channel] / 255 - mean[channel]) / std[channel];
    }
  }
  const session = await getSession(model);
  signal?.throwIfAborted();
  const output = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 224, 224]),
  });
  signal?.throwIfAborted();
  const tensor = output[session.outputNames[0]];
  const [, tokens, hidden] = tensor.dims;
  const vector = new Float32Array(hidden);
  for (let token = 1; token < tokens; token += 1) {
    for (let index = 0; index < hidden; index += 1) {
      vector[index] += tensor.data[token * hidden + index] / (tokens - 1);
    }
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

export async function embedImage(
  filePath,
  { model, cacheDir = "data/cache/embeddings", fingerprint, signal } = {},
) {
  signal?.throwIfAborted();
  const selectedModel = modelPath(model);
  try {
    await access(selectedModel);
  } catch {
    return null;
  }
  const key =
    fingerprint || crypto.createHash("sha256").update(filePath).digest("hex");
  const cachePath = path.resolve(cacheDir, `${key}.json`);
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    signal?.throwIfAborted();
    const vector = await embedRaw(filePath, selectedModel, signal);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(vector));
    return vector;
  }
}

export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / Math.sqrt(Math.max(1e-12, leftNorm * rightNorm));
}

export function clusterByEmbedding(items, threshold = 0.78) {
  const groups = [];
  for (const item of items) {
    const group = groups.find((members) =>
      members.every(
        (member) =>
          cosineSimilarity(member.embedding, item.embedding) >= threshold,
      ),
    );
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((members, index) => ({
    groupId: `embedding-${String(index + 1).padStart(4, "0")}`,
    size: members.length,
    representativeId: members[0].id,
    similarityMethod: "dinov2-mean-patch",
    cosineThreshold: threshold,
    items: members,
  }));
}
