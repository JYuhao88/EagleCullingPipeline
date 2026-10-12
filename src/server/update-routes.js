import { json } from './http.js';

export function createUpdateRouter(updater) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/update/')) return false;
    // Reject browser requests from remote sites, including JSON preflights.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) {
      return json(res, 403, { error: '更新只允许本机插件操作' });
    }
    if (req.method === 'GET' && url.pathname === '/update/status') return json(res, 200,
      await updater.status({ refresh: url.searchParams.get('refresh') === '1' }));
    if (req.method === 'POST' && ['/update/apply', '/update/rollback'].includes(url.pathname)) {
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
      if (updater.updating) return json(res, 409, { error: '正在更新，请稍候' });
      // The operation survives a lost HTTP connection; progress is polled separately.
      const operation = updater.apply({ rollback: url.pathname.endsWith('/rollback') });
      operation.catch(() => {});
      return json(res, 202, { accepted: true });
    }
    if (req.method === 'OPTIONS') return json(res, 204, {});
    return json(res, 404, { error: 'not found' });
  };
}
