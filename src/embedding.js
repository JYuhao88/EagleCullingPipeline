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
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  return dot / Math.sqrt(Math.max(1e-12, aa * bb));
}

export function clusterByEmbedding(items, threshold = 0.82) {
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error("Cosine threshold must be from -1 to 1");
  const prepared = items.map(item => {
    const values = item.embedding;
    const norm = values?.length && Array.from(values).every(Number.isFinite) ? Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)) : 0;
    return {item,vector:norm > 0 && Number.isFinite(norm) ? Array.from(values,value=>value/norm) : null};
  }).sort((a,b)=>(Number.isFinite(b.item.qualityScore) ? b.item.qualityScore : 0)-(Number.isFinite(a.item.qualityScore) ? a.item.qualityScore : 0)||String(a.item.id).localeCompare(String(b.item.id)));
  const similar = (a,b) => {
    if (!a.vector || !b.vector || a.vector.length !== b.vector.length) return false;
    let dot=0, distanceSquared=0;
    // For unit vectors, ||a-b||² = 2(1-cosine). A partial squared
    // distance can only increase, so reject dissimilar candidates early
    // without approximating their final threshold decision.
    const distanceLimit=2*(1-threshold);
    for (let index=0;index<a.vector.length;index++) {
      const difference=a.vector[index]-b.vector[index];distanceSquared+=difference*difference;
      if(distanceSquared>distanceLimit+1e-12) return false;
      dot+=a.vector[index]*b.vector[index];
    }
    return dot>=threshold;
  };
  const groups=[];
  for (const candidate of prepared) {
    const group=groups.find(members=>members.every(member=>similar(candidate,member)));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  return groups.map((members,index)=>({groupId:`embedding-${String(index+1).padStart(4,"0")}`,size:members.length,representativeId:members[0].item.id,similarityMethod:"embedding-pairwise-v2",cosineThreshold:threshold,items:members.map(member=>member.item)}));
}
