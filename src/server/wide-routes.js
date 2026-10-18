import { randomUUID } from 'node:crypto';
import { json } from './http.js';

// Eagle stops its right panel at 600 px and gives the panel no way to open the main plugin window; on Windows the two
// pages do not even share storage. The panel's 宽屏查看 asks here, and the main window, waiting on GET, opens the
// wide inspector. `boot` changes when the service restarts, so a waiting window rebases instead of replaying.
export function createWideRouter({ holdMs = 25000 } = {}) {
  const boot = randomUUID().slice(0, 8);
  let seq = 0;
  const waiters = new Set();
  const settle = waiter => {
    waiters.delete(waiter); clearTimeout(waiter.timer);
    if (!waiter.res.writableEnded && !waiter.res.destroyed) json(waiter.res, 200, { boot, seq });
  };
  return async function route(req, res, url) {
    if (url.pathname !== '/ui/wide') return false;
    if (req.method === 'POST') {
      seq++;
      for (const waiter of [...waiters]) settle(waiter);
      return json(res, 200, { boot, seq });
    }
    if (req.method !== 'GET') return json(res, 405, { error: '只支持 GET 和 POST' });
    const after = url.searchParams.get('after');
    if (url.searchParams.get('boot') !== boot || after === null || Number(after) !== seq) return json(res, 200, { boot, seq });
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => settle(waiter), holdMs);
    waiters.add(waiter);
    res.on('close', () => { waiters.delete(waiter); clearTimeout(waiter.timer); });
    return true;
  };
}
