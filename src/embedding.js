let extractorPromise;

export async function createEmbeddingExtractor({ model = process.env.EAGLE_EMBEDDING_MODEL || "Xenova/dinov2-small", cacheDir = process.env.EAGLE_MODEL_CACHE } = {}) {
  if (!extractorPromise) {
    extractorPromise = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
      env.allowLocalModels = true;
      env.allowRemoteModels = process.env.EAGLE_OFFLINE !== "1";
      if (cacheDir) env.cacheDir = cacheDir;
      // q8 is more stable on Windows' bundled ONNX Runtime than fp16 and is
      // small enough to keep the model fully local. CUDA execution remains an
      // optional provider when the runtime exposes it.
      return pipeline("image-feature-extraction", model, { dtype: "q8" });
    });
  }
  return extractorPromise;
}

export async function embedImage(filePath, options = {}) {
  const extractor = await createEmbeddingExtractor(options);
  const output = await extractor(filePath, { pooling: "mean", normalize: true });
  const dims = output.dims || [];
  const data = Array.from(output.data);
  // Some Transformers.js DINO exports ignore the pooling hint and return
  // [batch, tokens, hidden]. Mean-pool tokens explicitly for a compact vector.
  if (dims.length === 3 && dims[0] === 1) {
    const tokens = dims[1]; const hidden = dims[2];
    const pooled = new Array(hidden).fill(0);
    for (let t = 0; t < tokens; t += 1) for (let h = 0; h < hidden; h += 1) pooled[h] += data[t * hidden + h] / tokens;
    const norm = Math.sqrt(pooled.reduce((sum, value) => sum + value * value, 0)) || 1;
    return pooled.map((value) => value / norm);
  }
  return data;
}

export function cosineSimilarity(a, b) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.sqrt(Math.max(1e-12, aa * bb));
}

export function clusterByEmbedding(items, threshold = 0.82) {
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
    if (items[i].embedding && items[j].embedding && cosineSimilarity(items[i].embedding, items[j].embedding) >= threshold) union(i, j);
  }
  const groups = new Map();
  items.forEach((item, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(item); });
  return [...groups.values()].map((members, index) => ({ groupId: `embedding-${String(index + 1).padStart(4, "0")}`, size: members.length, representativeId: [...members].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))[0].id, items: members }));
}
