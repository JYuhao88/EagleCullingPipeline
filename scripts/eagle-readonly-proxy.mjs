import http from 'node:http';
const reads = /^\/api(?:\/v2)?\/(?:library\/info|app\/info|folder\/list|item\/list|item\/info|item\/thumbnail)$/;
export function isReadOnlyEagleRequest(method, pathname) {
  return method === 'GET' && reads.test(pathname);
}
export function createReadOnlyEagleProxy(upstream = 'http://127.0.0.1:41595') {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const entry = { method: req.method, path: url.pathname, query: url.search,
      allowed: isReadOnlyEagleRequest(req.method, url.pathname) };
    requests.push(entry);
    if (!entry.allowed) { entry.status = 405; res.writeHead(405); res.end('Read-only Eagle guard'); return; }
    try {
      const response = await fetch(new URL(url.pathname + url.search, upstream),
        { redirect: 'error', signal: AbortSignal.timeout(15000) });
      entry.status = response.status;
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { entry.status = 502; entry.error = error.message; res.writeHead(502); res.end('Upstream failed'); }
  });
  return { server, requests, summary: () => requests.reduce((counts, r) => {
    const key = `${r.method} ${r.path}`; counts[key] = (counts[key] || 0) + 1; return counts;
  }, {}) };
}
