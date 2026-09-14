#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { EagleApi } from "./eagle-api.js";
import { collectInventory, writeInventoryAtomic } from "./inventory.js";
import { analyzeImage, applyFaceQuality, clusterByPhash, listEagleImages } from "./image-analyzer.js";
import { applyReview, loadReview } from "./review.js";
import { createAnalysisServer } from "./server.js";
import { writeRecommendations } from "./recommend.js";
import { writeBenchmark } from "./benchmark.js";
import { embedImage, createEmbeddingExtractor, clusterByEmbedding } from "./embedding.js";
import { verifyModels } from "./models.js";
import { runFaceWorker } from "./face-worker-client.js";

const api = new EagleApi();

async function doctor() {
  let app;
  let library;
  try {
    [app, library] = await Promise.all([api.appInfo(), api.libraryInfo()]);
  } catch (error) {
    if (error.status === 404) {
      throw new Error(
        "Eagle is reachable, but Web API V2 is unavailable. Upgrade Eagle to 4.0 Build 21+ before running inventory.",
      );
    }
    throw error;
  }
  console.log(JSON.stringify({
    ok: true,
    application: app,
    library: {
      name: library.name,
      path: library.path,
      applicationVersion: library.applicationVersion,
    },
  }, null, 2));
}

async function inventory() {
  const outputPath = path.resolve("data", "inventory.json");
  const result = await collectInventory(api);
  await writeInventoryAtomic(result, outputPath);
  console.log(`Saved ${result.itemCount} items to ${outputPath}`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function analyze() {
  const libraryPath = option("--library", process.env.EAGLE_LIBRARY_PATH || "D:/Photography/EagleLibraries/Culling.library");
  const limit = Number(option("--limit", "0")) || undefined;
  const threshold = Number(option("--phash-threshold", "8"));
  const concurrency = Math.max(1, Math.min(16, Number(option("--concurrency", "4")) || 4));
  const useEmbeddings = process.argv.includes("--embeddings");
  const useFaces = process.argv.includes("--faces");
  const records = await listEagleImages(libraryPath, { limit });
  const analyzed = new Array(records.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= records.length) return;
      try { analyzed[index] = await analyzeImage(records[index]); }
      catch (error) { analyzed[index] = { ...records[index], analysisError: error.message }; }
      completed += 1;
      if (completed % 100 === 0 || completed === records.length) console.log(`Progress ${completed}/${records.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  if (useFaces) {
    const faceResults = await runFaceWorker(records.map((item) => ({ ...item, filePath: item.thumbnailPath || item.filePath })));
    const byId = new Map(faceResults.map((result) => [result.id, result]));
    for (let index = 0; index < analyzed.length; index += 1) {
      analyzed[index] = applyFaceQuality(analyzed[index], byId.get(analyzed[index].id) || { error: "no worker result" });
    }
  }
  let groups = clusterByPhash(analyzed.filter((item) => item.phash), threshold);
  if (useEmbeddings) {
    await createEmbeddingExtractor({ model: option("--embedding-model", undefined) });
    let embedded = 0;
    for (const item of analyzed) {
      try { item.embedding = await embedImage(item.filePath); embedded += 1; }
      catch (error) { item.embeddingError = error.message; }
      if (embedded % 25 === 0 || embedded === analyzed.length) console.log(`Embedding progress ${embedded}/${analyzed.length}`);
    }
    groups = clusterByEmbedding(analyzed.filter((item) => item.embedding), Number(option("--embedding-threshold", "0.82")));
  }
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    libraryPath,
    itemCount: analyzed.length,
    analyzedCount: analyzed.filter((item) => item.phash).length,
    embeddingCount: analyzed.filter((item) => item.embedding).length,
    faceCount: analyzed.filter((item) => item.face?.faceCount != null).length,
    errorCount: analyzed.filter((item) => item.analysisError).length,
    groups,
    items: analyzed,
  };
  const outputPath = option("--output", path.resolve("data", "analysis.json"));
  await writeInventoryAtomic(result, outputPath);
  console.log(`Analyzed ${result.analyzedCount}/${result.itemCount} items; wrote ${groups.length} groups to ${outputPath}`);
}

async function apply() {
  const reviewPath = option("--review", "data/review.json");
  const review = await loadReview(reviewPath);
  const confirm = option("--confirm", "");
  const shouldApply = process.argv.includes("--apply") && confirm === "APPLY_REVIEW";
  let folderMap = {};
  const folderMapPath = option("--folder-map", undefined);
  if (folderMapPath) folderMap = JSON.parse(await readFile(folderMapPath, "utf8"));
  // Build updates from a fresh Eagle snapshot when writing. This preserves
  // user tags/folders and avoids applying a plan to items changed meanwhile.
  const lookup = new Map();
  if (shouldApply) {
    const current = [];
    for await (const item of api.items({ limit: 500 })) current.push(item);
    current.forEach((item) => lookup.set(item.id, item));
  } else {
    try {
      const cached = JSON.parse(await readFile("data/inventory.json", "utf8"));
      for (const item of cached.items || []) lookup.set(item.id, item);
    } catch { /* dry-run can still show a valid plan without a snapshot */ }
  }
  const result = await applyReview(api, review, { apply: shouldApply, lookup, folderMap });
  if (!shouldApply) {
    console.log(JSON.stringify({ mode: "dry-run", decisionCount: result.plan.length, plan: result.plan }, null, 2));
    console.log("No Eagle changes made. To apply, pass --apply --confirm APPLY_REVIEW.");
    return;
  }
  console.log(`Applied ${result.plan.length} reviewed updates to Eagle.`);
}

async function serve() {
  const port = Number(option("--port", process.env.CULLING_PORT || "43125"));
  const service = createAnalysisServer({ port });
  await service.listen();
  console.log(`Local analysis service listening on http://127.0.0.1:${port}`);
  await new Promise(() => {});
}

async function recommend() {
  const analysisPath = option("--analysis", "data/analysis.json");
  const outputPath = option("--output", "data/review.json");
  const review = await writeRecommendations(analysisPath, outputPath);
  console.log(`Generated ${review.decisions.length} review decisions at ${outputPath}; no Eagle changes made.`);
}

async function benchmark() {
  const analysisPath = option("--analysis", "data/analysis.json");
  const outputPath = option("--output", "data/benchmark.json");
  const size = Math.max(1, Number(option("--size", "300")) || 300);
  const set = await writeBenchmark(analysisPath, outputPath, size);
  console.log(`Generated ${set.items.length}-item benchmark manifest at ${outputPath}; no Eagle changes made.`);
}

async function models() {
  const results = await verifyModels();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

const commands = { doctor, inventory, analyze, apply, serve, recommend, benchmark, models };
const command = process.argv[2];

if (!commands[command]) {
  console.error("Usage: node src/cli.js <doctor|inventory|analyze|apply> [options]");
  process.exitCode = 2;
} else {
  commands[command]().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
