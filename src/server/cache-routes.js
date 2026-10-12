import { cacheUsage, readCacheLimit, writeCacheLimit, enforceCacheBudget, GB } from '../core/cache-budget.js';
import { json, parseBody } from './http.js';
export function createCacheRouter({ cacheRoot, isBusy, maintenance, lock = { busy: false } }) {
  return async (req, res, url) => {
    if (!['/cache/usage', '/cache/limit', '/cache/clear'].includes(url.pathname)) return false;
    if (req.method === 'GET' && url.pathname === '/cache/usage') {
      return json(res, 200, { ...await cacheUsage(cacheRoot), maxBytes: await readCacheLimit(cacheRoot) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const body = await parseBody(req);
    if (url.pathname === '/cache/limit') {
      if (!Number.isSafeInteger(body.maxBytes) || body.maxBytes < GB || body.maxBytes > 200 * GB)
        return json(res, 400, { error: '缓存上限须为 1–200 GB' });
      await writeCacheLimit(cacheRoot, body.maxBytes);
      return json(res, 200, { maxBytes: body.maxBytes });
    }
    if (url.pathname !== '/cache/clear') return json(res, 405, { error: 'Method not allowed' });
    if (!['derived', 'all'].includes(body.scope)) return json(res, 400, { error: 'Invalid cache scope' });
    if (isBusy() || lock.busy) return json(res, 409, { error: '分析或清理正在进行，请稍后重试' });
    lock.busy = true;
    try {
      await maintenance?.cancel();
      const result = await enforceCacheBudget({ cacheRoot, maxBytes: 0, scope: body.scope });
      return json(res, 200, { ...result, maxBytes: await readCacheLimit(cacheRoot) });
    } finally { lock.busy = false; }
  };
}
