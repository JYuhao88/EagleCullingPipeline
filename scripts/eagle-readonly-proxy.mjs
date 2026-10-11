import http from 'node:http';
import crypto from 'node:crypto';
const reads = /^\/api(?:\/v2)?\/(?:library\/info|app\/info|folder\/list|item\/list|item\/info|item\/thumbnail)$/;
export function isReadOnlyEagleRequest(method, pathname) {
  return method === 'GET' && reads.test(pathname);
}
export function createReadOnlyEagleProxy(upstream = 'http://127.0.0.1:41595', { switchLibraries = [], auditRequest } = {}) {
  const normalize = value => String(value).normalize('NFC').replace(/[\\/]+$/, '').toLowerCase();
  const switchPaths = new Set(switchLibraries.filter(p => !p.includes('未删减')).map(normalize));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let switchBody;
    const switchRequest = req.method === 'POST' && url.pathname === '/api/library/switch';
    if (switchRequest && switchPaths.size) {
      try {
        let data = '';
        for await (const chunk of req) { data += chunk; if (data.length > 65536) throw new Error('Body too large'); }
        const body = JSON.parse(data);
        if (Object.keys(body).length === 1 && typeof body.libraryPath === 'string' &&
            !body.libraryPath.includes('未删减') && switchPaths.has(normalize(body.libraryPath))) switchBody = body;
      } catch { /* Invalid or unlisted switch targets are never forwarded. */ }
    }
    const entry = { method: req.method, path: url.pathname, query: url.search,
      allowed: isReadOnlyEagleRequest(req.method, url.pathname) || Boolean(switchBody),
      kind: switchBody ? 'library-switch' : switchRequest ? 'denied-switch' : 'read',
      ...(switchBody ? { targetHash: crypto.createHash('sha256').update(normalize(switchBody.libraryPath)).digest('hex') } : {}) };
    requests.push(entry);
    if (auditRequest) {
      try { await auditRequest({ ...entry }); }
      catch { entry.allowed = false; entry.status = 503; res.writeHead(503); res.end('Audit unavailable'); return; }
    }
    if (!entry.allowed) { entry.status = 405; res.writeHead(405); res.end('Read-only Eagle guard'); return; }
    try {
      const response = await fetch(new URL(url.pathname + url.search, upstream),
        { redirect: 'error', signal: AbortSignal.timeout(15000),
          ...(switchBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(switchBody) } : {}) });
      entry.status = response.status;
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { entry.status = 502; entry.error = error.message; res.writeHead(502); res.end('Upstream failed'); }
  });
  return { server, requests, summary: () => requests.reduce((counts, r) => {
    const key = `${r.method} ${r.path}`; counts[key] = (counts[key] || 0) + 1; return counts;
  }, {}) };
}
