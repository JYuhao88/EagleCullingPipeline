import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { analyzeImage, applyFaceQuality, clusterByPhash } from "./image-analyzer.js";
import { runFaceWorker } from "./face-worker-client.js";
import { createBadgeThumbnail } from "./badge-thumbnail.js";
import { TaskStore } from "./task-store.js";

const SERVICE_VERSION = "0.3.0";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
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

export function createAnalysisServer({ host = "127.0.0.1", port = 43125, taskStorePath } = {}) {
  const taskStore = new TaskStore(taskStorePath);
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}:${port || 43125}`);
    const pathname = requestUrl.pathname;
    if (req.method === "GET" && pathname === "/health") return json(res, 200, { ok: true, service: "eagle-culling" });
    if (req.method === "GET" && pathname === "/version") return json(res, 200, { service: "eagle-culling", version: SERVICE_VERSION, apiVersion: 1 });
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
        const task = command === "progress" || command === "checkpoint"
          ? await (async () => {
            const body = await readJsonBody(req);
            if (command === "checkpoint") {
              if (!Array.isArray(body.items)) throw new Error("items is required");
              return taskStore.updateItems(taskId, body.items);
            }
            if (body.itemId === undefined) throw new Error("itemId is required");
            return taskStore.updateItem(taskId, body.itemId, body);
          })()
          : await taskStore.command(taskId, command);
        return task ? json(res, 200, task) : json(res, 404, { error: "task not found" });
      } catch (error) {
        return json(res, error.statusCode || 400, { error: error.message });
      }
    }
    if (req.method !== "POST" || !["/analyze", "/badge-thumbnail"].includes(pathname)) return json(res, 404, { error: "Not found" });
    try {
      const body = await readJsonBody(req);
      if (pathname === "/badge-thumbnail") {
        if (!body.outputPath && body.badgeKey) body.outputPath = path.resolve("data", "thumbnail-badges", `${String(body.badgeKey).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
        const result = await createBadgeThumbnail(body);
        return json(res, 200, result);
      }
      if (!Array.isArray(body.items) || body.items.length > 500) return json(res, 400, { error: "items must be an array of at most 500 records" });
      const items = [];
      for (const item of body.items) items.push(await analyzeImage(item));
      if (body.includeFaces) {
        const faceResults = await runFaceWorker(body.items.map((item) => ({ ...item, filePath: item.thumbnailPath || item.filePath })));
        const byId = new Map(faceResults.map((result) => [result.id, result]));
        for (let index = 0; index < items.length; index += 1) {
          items[index] = applyFaceQuality(items[index], byId.get(items[index].id) || { available: false, error: "no worker result" });
        }
      }
      return json(res, 200, { items, groups: clusterByPhash(items, Number(body.phashThreshold) || 8) });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  return { server, listen: () => new Promise((resolve) => server.listen(port, host, resolve)) };
}
