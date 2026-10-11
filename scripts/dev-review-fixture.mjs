import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { handleReviewRoute } from "../src/server/review-routes.js";

const root = path.resolve("src/plugin");
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};
const template = JSON.parse(await readFile("test/fixtures/review/results.json", "utf8"));
const runs = new Map();
let runNumber = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRun(id) {
  const data = clone(template);
  data.run.id = id;
  runs.set(id, data);
  return data;
}

const fixtureRun = makeRun(template.run.id);

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

async function preview(unitId) {
  const svg = `<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="600" fill="#31506b"/>
    <text x="450" y="320" text-anchor="middle" font-size="42" fill="white">${unitId}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function serveApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/runs") {
    const id = `fixture-run-${++runNumber}`;
    const data = makeRun(id);
    data.run.status = "completed";
    data.run.progress = { stage: "done", completed: 8, total: 8, cached: 8 };
    json(res, 202, data.run);
    return true;
  }
  const resultMatch = url.pathname.match(/^\/runs\/([^/]+)\/results$/);
  if (req.method === "GET" && resultMatch) {
    const data = runs.get(resultMatch[1]);
    if (data) json(res, 200, data);
    else json(res, 404, { error: "run not found" });
    return true;
  }
  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    const data = runs.get(runMatch[1]);
    if (data) json(res, 200, data.run);
    else json(res, 404, { error: "run not found" });
    return true;
  }
  const previewMatch = url.pathname.match(/^\/runs\/([^/]+)\/preview\/([^/]+)$/);
  if (req.method === "GET" && previewMatch && runs.has(previewMatch[1])) {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(await preview(decodeURIComponent(previewMatch[2])));
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:43126");
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, service: "review-fixture", contractVersion: 1 });
  }
  if (await serveApi(req, res, url)) return;
  const data = runs.get(url.pathname.split("/")[2]);
  const handled = await handleReviewRoute(req, res, {
    runStore: {
      async get(id) { return runs.get(id) || null; },
      dir(id) { return path.resolve("data/runs", id); }
    },
    api: {
      async assertLibrary() { return data?.run; },
      async updateItem() {},
      async moveToTrash() {}
    },
    json,
    readBody
  });
  if (handled) return;
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.join(root, relative);
  try {
    await stat(file);
    res.writeHead(200, { "content-type": STATIC_TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: "not found" });
  }
});

server.listen(43126, "127.0.0.1", () => {
  console.log("Review fixture: http://127.0.0.1:43126/index.html");
  console.log(`Run ID: ${fixtureRun.run.id}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
