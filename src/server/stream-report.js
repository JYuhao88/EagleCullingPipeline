import { buildReport, reportCsv } from '../core/report.js';
import { DecisionsStore } from '../core/decisions-store.js';
import { CORS_HEADERS } from './http.js';
import { pageOptions } from './pagination.js';

export async function streamReport(req, res, store, id, url, json) {
  let options;
  try { options = pageOptions(url); } catch (error) { json(res, 400, { error: error.message }); return true; }
  let data = await store.page(id, options);
  if (!data) { json(res, 404, { error: 'run not found' }); return true; }
  const paged = url.searchParams.has('limit') || url.searchParams.has('cursor');
  const csv = url.searchParams.get('format') === 'csv';
  const decisions = await new DecisionsStore(store.dir(id)).read();
  const applied = await store.applied(id);
  const decisionMap = new Map(decisions.map(row => [row.unitId, row]));
  const appliedMap = new Map(applied.map(row => [row.id, row]));
  async function write(chunk) {
    if (res.destroyed) throw new Error('Report client disconnected');
    if (!res.write(chunk)) await new Promise((resolve, reject) => {
      const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
      const drain = () => { cleanup(); resolve(); };
      const close = () => { cleanup(); reject(new Error('Report client disconnected')); };
      const error = value => { cleanup(); reject(value); };
      res.once('drain', drain); res.once('close', close); res.once('error', error);
    });
  }
  res.writeHead(200, { 'content-type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', ...CORS_HEADERS });
  if (csv) await write(reportCsv([]).replace(/\n$/, ''));
  else await write(paged ? '{"rows":[' : '[');
  let first = true;
  while (data) {
    const ids = new Set(data.units.map(row => row.id));
    const itemIds = new Set(data.items.map(row => row.id));
    const rows = buildReport({ ...data, decisions: [...ids].map(key => decisionMap.get(key)).filter(Boolean),
      applied: [...itemIds].map(key => appliedMap.get(key)).filter(Boolean) });
    for (const row of rows) {
      if (csv) await write(reportCsv([row]).split('\n').slice(1).join('\n'));
      else { await write((first ? '' : ',') + JSON.stringify(row)); first = false; }
    }
    if (paged || !data.page.nextCursor) break;
    data = await store.page(id, { ...options, cursor: Number(data.page.nextCursor) });
  }
  if (!csv) await write(paged ? `],"page":${JSON.stringify(data.page)}}` : ']');
  res.end();
  return true;
}
