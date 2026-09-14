import http from "node:http";
import { analyzeImage, applyFaceQuality, clusterByPhash } from "./image-analyzer.js";
import { runFaceWorker } from "./face-worker-client.js";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function createAnalysisServer({ host = "127.0.0.1", port = 43125 } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, service: "eagle-culling" });
    if (req.method !== "POST" || req.url !== "/analyze") return json(res, 404, { error: "Not found" });
    try {
      const chunks = [];
      let bodyBytes = 0;
      for await (const chunk of req) {
        bodyBytes += chunk.length;
        if (bodyBytes > 2 * 1024 * 1024) return json(res, 413, { error: "request body exceeds 2 MiB" });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
