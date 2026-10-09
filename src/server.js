import http from "node:http";
import os from "node:os";
import sharp from "sharp";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { analyzeImage, applyFaceQuality, clusterByPhash, hashFile } from "./image-analyzer.js";
import { ResourceGate } from "./resource-gate.js";
import { FaceWorkerPool } from "./face-worker-client.js";
import { SemanticWorkerPool } from "./semantic-worker-client.js";
import { setMaxListeners } from "node:events";
import { SemanticClusterQueue } from "./semantic-cluster.js";
import { ModelPreviewCache } from "./model-preview.js";
import { createBadgeThumbnail } from "./badge-thumbnail.js";
import { TaskStore } from "./task-store.js";
import { ThumbnailBackupStore } from "./thumbnail-backup.js";
import { APP_VERSION, REQUIRED_CAPABILITIES } from "./plugin/runtime-contract.js";

function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function taskSummary(task) {
  const { items, ...summary } = task;
  return summary;
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    bodyBytes += chunk.length;
    if (bodyBytes > maxBytes) throw Object.assign(new Error(`request body exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB`), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createAnalysisServer({ host = "127.0.0.1", port = 43125, taskStorePath, thumbnailBackupRoot, modelPreviewRoot, faceWorkerOptions, semanticWorkerOptions, imageResourceOptions, nativeImageThreads } = {}) {
  const taskStore = new TaskStore(taskStorePath);
  const backups = new ThumbnailBackupStore(thumbnailBackupRoot);
  const facePool = new FaceWorkerPool(faceWorkerOptions);
  const semanticPool = new SemanticWorkerPool(semanticWorkerOptions);
  const semanticClusters = new SemanticClusterQueue();
  const modelPreviews = new ModelPreviewCache(modelPreviewRoot);
  const imageGate = new ResourceGate(imageResourceOptions);
  const threads = nativeImageThreads ?? (Number(process.env.EAGLE_IMAGE_THREADS) || Math.max(1, Math.floor(os.availableParallelism() / (imageGate.concurrency + facePool.options.size + 2))));
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("Native image thread count must be a positive integer");
  sharp.concurrency(threads);
  const handleRequest = async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}:${port || 43125}`);
    const pathname = requestUrl.pathname;
    if (req.method === "GET" && pathname === "/health") {
      try { await taskStore.ready; }
      catch (error) { return json(res, 503, { ok: false, service: "eagle-culling", error: error.message }); }
      if (taskStore.persistenceError) return json(res, 503, { ok: false, service: "eagle-culling", error: taskStore.persistenceError.message });
      return json(res, 200, { ok: true, service: "eagle-culling" });
    }
    if (req.method === "GET" && pathname === "/diagnostics") return json(res, 200, { image: { ...imageGate.diagnostics(), nativeThreads: sharp.concurrency(), nativeQueue: sharp.counters() }, face: facePool.diagnostics(), semantic:semanticPool.diagnostics(), clustering:semanticClusters.diagnostics(), memory: process.memoryUsage() });
    if (req.method === "GET" && pathname === "/version") return json(res, 200, { service: "eagle-culling", version: APP_VERSION, apiVersion: 1, capabilities: REQUIRED_CAPABILITIES });
    if (req.method === "GET" && pathname === "/tasks") return json(res, 200, { tasks: await taskStore.list({ includeItems: requestUrl.searchParams.get("includeItems") === "true" }) });
    if (req.method === "GET" && pathname.startsWith("/tasks/")) {
      const task = await taskStore.get(pathname.split("/")[2]);
      return task ? json(res, 200, task) : json(res, 404, { error: "task not found" });
    }
    if (req.method === "GET" && pathname === "/badge-manifest") {
      try {
        const manifestPath = path.resolve("data", "thumbnail-badges.json");
        return json(res, 200, JSON.parse(await readFile(manifestPath, "utf8")));
      } catch (error) {
        return json(res, 404, { error: `badge manifest unavailable: ${error.message}` });
      }
    }
    if (req.method === "POST" && pathname === "/tasks") {
      try {
        const body = await readJsonBody(req);
        if (!body.taskType) return json(res, 400, { error: "taskType is required" });
        return json(res, 201, await taskStore.create(body));
      } catch (error) {
        return json(res, error.statusCode || 400, { error: error.message });
      }
    }
    if (req.method === "POST" && pathname.startsWith("/tasks/")) {
      const parts = pathname.split("/").filter(Boolean);
      const taskId = parts[1];
      const command = parts[2];
      try {
        if (command === "plan" || command === "seal") {
          const task = command === "plan" ? await taskStore.appendPlan(taskId, await readJsonBody(req)) : await taskStore.sealPlan(taskId);
          if (!task) return json(res, 404, { error: "task not found" });
          const { items, ...summary } = task;
          return json(res, 200, summary);
        }
        if (["claim", "heartbeat", "release", "recover"].includes(command)) {
          const body = await readJsonBody(req);
          const task = await taskStore.execution(taskId, command, body);
          if (!task) return json(res, 404, { error: "task not found" });
          const { items, ...summary } = task;
          return json(res, 200, summary);
        }
        if (command === "configure") {
          const config = await readJsonBody(req);
          if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || !Number.isFinite(config.delayMs) || config.delayMs < 0) return json(res, 400, { error: "concurrency must be a positive integer and delayMs must be non-negative" });
          const current = await taskStore.get(taskId);
          if (!current) return json(res, 404, { error: "task not found" });
          if (!["paused", "failed", "pending"].includes(current.status)) return json(res, 409, { error: "pause task before changing configuration" });
          const updated = await taskStore.update(taskId, { config: { ...current.config, concurrency: config.concurrency, delayMs: config.delayMs } });
          return json(res, 200, requestUrl.searchParams.get("includeItems") === "false" ? taskSummary(updated) : updated);
        }
        const task = command === "progress" || command === "checkpoint"
          ? await (async () => {
            const body = await readJsonBody(req);
            if (command === "checkpoint") {
              if (!Array.isArray(body.items)) throw new Error("items is required");
              return taskStore.updateItems(taskId, body.items, req.headers["x-task-owner"]);
            }
            if (body.itemId === undefined) throw new Error("itemId is required");
            return taskStore.updateItems(taskId, [{ ...body, itemId: body.itemId }], req.headers["x-task-owner"]);
          })()
          : await taskStore.command(taskId, command, req.headers["x-task-owner"]);
        if (task && (requestUrl.searchParams.get("includeItems") === "false" || command === "checkpoint" && requestUrl.searchParams.get("includeItems") !== "true")) {
          return json(res, 200, taskSummary(task));
        }
        return task ? json(res, 200, task) : json(res, 404, { error: "task not found" });
      } catch (error) {
        return json(res, error.statusCode || 400, { error: error.message });
      }
    }
    if (req.method !== "POST" || !["/analyze", "/badge-thumbnail", "/cluster", "/thumbnail-backup", "/thumbnail-backup/read", "/thumbnail-fingerprint"].includes(pathname)) return json(res, 404, { error: "Not found" });
    try {
      const body = await readJsonBody(req);
      const phashThreshold = Number(body.phashThreshold ?? 8);
      if (["/analyze", "/cluster"].includes(pathname) && (!Number.isInteger(phashThreshold) || phashThreshold < 0 || phashThreshold > 64)) return json(res, 400, { error: "pHash threshold must be an integer from 0 to 64" });
      const controller = new AbortController();
      res.once("close", () => { if (!res.writableEnded) controller.abort(new Error("Analysis client disconnected")); });
      if (pathname === "/thumbnail-fingerprint") return json(res, 200, await hashFile(body.sourcePath));
      if (pathname === "/thumbnail-backup" || pathname === "/thumbnail-backup/read") {
        if (pathname.endsWith("/read") && !await backups.matches(body.sourcePath, body.badgeSha256)) return json(res, 200, { backup: null, reason: "当前缩略图与登记角标不一致或无校验记录，保留人工修改" });
        const backup = pathname.endsWith("/read")
          ? await backups.get(body.libraryPath, body.itemId)
          : await backups.prepare(body);
        return json(res, 200, { backup });
      }
      if (pathname === "/cluster") {
        let clusterItems = body.items;
        if (body.taskId) {
          const task = await taskStore.get(body.taskId);
          if (!task) return json(res, 404, { error: "task not found" });
          clusterItems = task.items.filter((item) => item.result).map((item) => item.result);
        }
        if (!Array.isArray(clusterItems)) return json(res, 400, { error: "items or taskId is required" });
        if (body.includeEmbeddings === true) {
          const threshold = Number(body.cosineThreshold ?? 0.94);
          if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) return json(res, 400, {error:"Cosine threshold must be from -1 to 1"});
          const groups = await semanticClusters.run(clusterItems, threshold, {signal:controller.signal});
          controller.signal.throwIfAborted();
          const assigned = new Set(groups.flatMap(group=>group.items.map(item=>item.id)));
          const fallback = clusterItems.filter(item=>!assigned.has(item.id));
          return json(res,200,{groups:[...groups,...clusterByPhash(fallback.filter(item=>item.phash),phashThreshold)],semantic:{available:assigned.size,total:clusterItems.length,threshold,warning:"场景相似不等于重复，粗排首选需人工确认"}});
        }
        return json(res, 200, { groups: clusterByPhash(clusterItems.filter((item) => item.phash), phashThreshold) });
      }
      if (pathname === "/badge-thumbnail") {
        if (!body.outputPath && body.badgeKey) body.outputPath = path.resolve("data", "thumbnail-badges", `${String(body.badgeKey).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
        const result = await imageGate.run(() => createBadgeThumbnail(body), {signal:controller.signal});
        controller.signal.throwIfAborted();
        if (!result.skipped) {
          result.badgeSha256 = (await hashFile(result.outputPath)).sha256;
        }
        return json(res, 200, result);
      }
      if (!Array.isArray(body.items) || body.items.length > 500) return json(res, 400, { error: "items must be an array of at most 500 records" });
      const items = [];
      const modelInputs = [];
      setMaxListeners(Math.max(10,body.items.length+2),controller.signal);
      const preparation = body.items.map(item=>imageGate.run(async()=>{
          controller.signal.throwIfAborted();
          const preview = body.highQualityPreviews === true && (body.includeFaces || body.includeEmbeddings) ? await modelPreviews.prepare(item) : null;
          const analysis = await analyzeImage(item);
          return {item,analysis,preview};
        }, { signal: controller.signal }).catch(error=>{controller.abort(error);throw error;}));
      // Preserve input order and drain active decoders before reporting a
      // failure. Parallelism stays inside the existing memory-aware gate.
      const preparedResults = await Promise.allSettled(preparation);
      const failedPreparation = preparedResults.find(result=>result.status==="rejected");
      if (failedPreparation) throw failedPreparation.reason;
      for (const result of preparedResults) {
        const prepared = result.value, item = prepared.item;
        items.push({...prepared.analysis,...(prepared.preview ? {modelPreview:prepared.preview} : {})});
        modelInputs.push({...item,analysisPath:prepared.preview?.path || item.analysisPath || item.thumbnailPath,scaleFallback:prepared.preview?.source === "jpeg-original-preview"});
      }
      controller.signal.throwIfAborted();
      if (body.includeFaces) {
        const faceResults = await facePool.run(modelInputs.map((item) => ({ id: item.id, filePath: item.analysisPath || item.thumbnailPath || item.filePath,scaleFallback:item.scaleFallback })), {signal:controller.signal}).catch((error) => body.items.map((item) => ({ id: item.id, available: false, error: { code: "worker_unavailable", message: error.message } })));
        controller.signal.throwIfAborted();
        const byId = new Map(faceResults.map((result) => [result.id, result]));
        for (let index = 0; index < items.length; index += 1) {
          const face = byId.get(items[index].id) || { available: false, error: "no worker result" };
          items[index] = applyFaceQuality(items[index], { ...face, available: face.available === true && !face.error });
        }
      }
      if (body.includeEmbeddings === true) {
        const vectors = await semanticPool.run(modelInputs, {signal:controller.signal}).catch(error=>body.items.map(item=>({id:item.id,available:false,error:error.message})));
        controller.signal.throwIfAborted();
        const byId = new Map(vectors.map(vector=>[vector.id,vector]));
        for (const item of items) {
          const vector = byId.get(item.id);
          item.semantic = {available:vector?.available === true,error:vector?.error || null};
          if (vector?.available) { item.embedding=vector.embedding; item.embeddingVersion=vector.embeddingVersion; }
        }
      }
      return json(res, 200, { items, groups: clusterByPhash(items, phashThreshold) });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  };
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (!res.writableEnded) json(res, 500, { error: error.message });
    });
  });
  server.on("close", () => { imageGate.close(); facePool.close(); semanticPool.close(); semanticClusters.close(); });
  return { server, listen: () => new Promise((resolve) => server.listen(port, host, resolve)) };
}
