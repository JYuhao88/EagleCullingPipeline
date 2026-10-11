import { enrichCaptureMetadata } from '../src/core/capture-metadata.js';
// Dedicated validation service: protected inventory, read-only Eagle, local review writes.
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir, access, appendFile } from 'node:fs/promises';
import { createReadOnlyEagleProxy } from './eagle-readonly-proxy.mjs';
import { inventory } from './windows-library.mjs';
import { EagleApi, normalizeLibraryPath } from '../src/core/eagle-api.js';
import { ResultsStore } from '../src/core/results-store.js';
import { RunStore } from '../src/server/run-store.js';
import { FaceWorkerPool, normalizeFaceResult } from '../src/core/faces.js';
if (process.platform !== 'win32') throw new Error('Windows validation service only');
const root = path.resolve('..');
const config = JSON.parse(await readFile(path.join(root, 'w12-libraries.json'), 'utf8'));
process.env.EAGLE_SCORER_PROVIDER = 'dml';
process.env.EAGLE_DINO_PROVIDER = 'dml';
process.env.EAGLE_POSE_PROVIDER = 'DmlExecutionProvider';
const { createAnalysisServer } = await import('../src/server.js');
const { AnalysisPipeline } = await import('../src/core/pipeline.js');
const { detectPose } = await import('../src/core/pose.js');
const port = Number(process.env.EAGLE_VALIDATION_PORT || 43125);
if (![43125, 43135].includes(port)) throw new Error('Unsupported validation port');
const data = path.resolve(process.env.EAGLE_VALIDATION_DATA || 'data/windows-user');
await mkdir(data, { recursive: true });
const journal = path.join(data, 'service-requests.jsonl');
const proxy = createReadOnlyEagleProxy(undefined, { switchLibraries: config.libraries,
  auditRequest: entry => appendFile(journal, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n') });
try {
  proxy.requests.push(...(await readFile(journal, 'utf8')).split('\n').filter(Boolean).map(JSON.parse));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await new Promise((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(port + 1, '127.0.0.1', resolve); });
const api = new EagleApi({ baseUrl: `http://127.0.0.1:${port + 1}/api/v2` });
const original = await api.libraryInfo();
if (String(original.path).includes('未删减') || !config.libraries.some(p => normalizeLibraryPath(p) ===
    normalizeLibraryPath(original.path))) throw new Error('Original active library must be in the safe allowlist');
await writeFile(path.join(data, 'original-library.json'), JSON.stringify({ path: original.path }));
const faces = new FaceWorkerPool({ size: 1 });
const pipeline = new AnalysisPipeline({ concurrency: 1, cacheRoot: path.join(data, 'cache'),
  store: new ResultsStore(path.join(data, 'cache')),
  faceDetector: async (files, options) => (await faces.run(files.map(filePath => ({ id: filePath, filePath })), options))
    .map(normalizeFaceResult),
  poseDetector: (items, options) => detectPose(items, { ...options, size: 1 }) });
const store = new RunStore(path.join(data, 'runs'));
const internal = createAnalysisServer({ port: 0, api, pipeline, runStore: store,
  scanItems: async (library, options) => {
    let { items } = await inventory(library, options);
    if (Array.isArray(options.itemIds)) {
      const selected = new Set(options.itemIds); items = items.filter(item => selected.has(item.id));
    }
    await enrichCaptureMetadata(items, options); return items;
  } });
await internal.listen();
const upstream = `http://127.0.0.1:${internal.server.address().port}`;
async function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(value));
}
const publicServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:43125');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type' }); res.end(); return;
    }
    if (url.pathname === '/validation/status' && req.method === 'GET') {
      return send(res, 200, { pid: process.pid, port,
        requests: proxy.summary(), switchCount: proxy.requests.filter(r => r.kind === 'library-switch').length,
        denied: proxy.requests.filter(r => !r.allowed).length,
        otherWriteRequests: proxy.requests.filter(r => r.method !== 'GET' && r.kind !== 'library-switch').length });
    }
    if (req.method === 'POST' && url.pathname === '/validation/restore') {
      const current = await api.libraryInfo();
      if (normalizeLibraryPath(current.path) !== normalizeLibraryPath(original.path)) {
        const response = await fetch(`http://127.0.0.1:${port + 1}/api/library/switch`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ libraryPath: original.path }) });
        if (!response.ok || (await response.json()).status !== 'success') throw new Error('Restore failed');
      }
      return send(res, 200, { restored: normalizeLibraryPath((await api.libraryInfo()).path) === normalizeLibraryPath(original.path) });
    }
    if (/\/(?:apply|writeback\/revert)$/.test(url.pathname)) return send(res, 403, { error: 'Validation service is read-only' });
    let body;
    if (req.method !== 'GET') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks);
    }
    if (req.method === 'POST' && url.pathname === '/runs') {
      try {
        if (port === 43125) throw Object.assign(new Error('User service is independent'), { code: 'ENOENT' });
        await access(path.join(root, 'gpu-external.lock'));
        return send(res, 409, { error: 'GPU 对照验证正在运行，请稍后再分析；已有结果仍可审阅。' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const request = JSON.parse(body);
      if (!request.resumeRunId) {
        const library = request.libraryPath;
        if (!config.libraries.some(p => normalizeLibraryPath(p) === normalizeLibraryPath(library))) {
          return send(res, 403, { error: 'Select an allowed validation library' });
        }
        if (!request.itemIds && request.items) request.itemIds = request.items.map(item => item.id);
        delete request.items;
        body = Buffer.from(JSON.stringify(request));
      }
    }
    const response = await fetch(upstream + req.url, { method: req.method, body,
      headers: body ? { 'content-type': 'application/json' } : undefined });
    let output = Buffer.from(await response.arrayBuffer());
    if (req.method === 'GET' && /\/results$/.test(url.pathname) && response.ok) {
      const value = JSON.parse(output); value.writebackAvailable = false; output = Buffer.from(JSON.stringify(value));
    }
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json',
      'access-control-allow-origin': '*', ...(response.headers.has('content-disposition')
        ? { 'content-disposition': response.headers.get('content-disposition') } : {}) });
    res.end(output);
  } catch { await send(res, 400, { error: 'Validation request failed; inspect local service log' }); }
});
await new Promise((resolve, reject) => { publicServer.once('error', reject); publicServer.listen(port, '127.0.0.1', resolve); });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const staticServer = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    const file = path.resolve('src/plugin', name);
    if (!file.startsWith(path.resolve('src/plugin') + path.sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(file); res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'text/plain' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { staticServer.once('error', reject); staticServer.listen(port + 2, '127.0.0.1', resolve); });
setInterval(() => { writeFile(path.join(data, 'service-requests.json'), JSON.stringify(proxy.requests)).catch(() => {}); }, 1000);
console.log(JSON.stringify({ service: 'ready', port, proxyPort: port + 1, pluginPagePort: port + 2, pid: process.pid }));
