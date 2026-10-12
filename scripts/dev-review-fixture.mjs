import http from 'node:http';
import path from 'node:path';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { handleReviewRoute } from '../src/server/review-routes.js';
import { RunStore } from '../src/server/run-store.js';
import { EagleApi } from '../src/core/eagle-api.js';

const port = 43451;
const root = path.resolve('src/plugin');
const temporary = await mkdtemp(path.join(tmpdir(), 'w24-review-fixture-'));
const store = new RunStore(path.join(temporary, 'runs'));
const template = JSON.parse(await readFile('test/fixtures/review/results.json', 'utf8'));
const items = new Map(), originals = new Map(), writes = [], smartFolders = [];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
for (const count of [2, 4, 8, 40]) {
  const id = `fixture-${count}`;
  const data = structuredClone(template);
  data.run = { ...data.run, id, itemCount: count, unitCount: count, groupCount: 1 };
  data.units = []; data.results = []; data.items = [];
  const group = { id: `group-${count}`, unitIds: [], ranking: [], suggested: {}, confidence: 'high' };
  for (let i = 0; i < count; i++) {
    const itemId = `${id}-photo-${i + 1}`, unitId = `unit:${itemId}`;
    const item = { id: itemId, name: `海边 · ${i + 1}`, tags: ['旅途', ...(i === 2 ? ['AI候选'] : [])], star: i === 1 ? 3 : 0 };
    data.items.push(item); items.set(itemId, structuredClone(item)); originals.set(itemId, structuredClone(item));
    data.units.push({ id: unitId, primaryItemId: itemId, itemIds: [itemId], formats: ['jpg'] });
    data.results.push({ ...structuredClone(template.results[i % template.results.length]), unitId,
      itemIds: [itemId], flags: i === 2 ? ['eyes-closed'] : i === 3 ? ['blurry'] : [] });
    group.unitIds.push(unitId); group.ranking.push({ unitId, rank: i + 1, score: .92 - i * .01, reasons: ['主体清晰，构图待人工确认'] });
    group.suggested[unitId] = i === 0 ? 'selected' : 'candidate';
  }
  data.groups = [group]; await store.save(data.run, data);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}
const api = new EagleApi({ baseUrl: `http://127.0.0.1:${port}/api/v2`, apiVersion: 2, expectedLibraryPath: '/fake.library' });
const ctx = { runStore: store, api, json, readBody };
const boot = `
const params = new URLSearchParams(location.search);
const count = [2,4,8,40].includes(Number(params.get('count'))) ? Number(params.get('count')) : 4;
localStorage.setItem('eagle-culling-base', location.origin);
localStorage.setItem('eagle-culling:review-welcome:v1', params.has('welcome') ? '' : 'dismissed');
for (const [key,value] of [['live-writeback',params.get('live') || '0'],['live-star',params.get('star') || '0']])
  localStorage.setItem('eagle-culling-'+key,value);
localStorage.removeItem('eagle-culling-smart-folders-created');
const folderCalls = [];
let themeListener;
window.eagle = { library: { path: '/fake.library', name: '模拟资源库' },
  app: { theme: params.get('theme') || 'DARK' }, onThemeChanged: callback => { themeListener = callback; },
  item: { getSelected: async () => [], countAll: async () => count }, folder: { getSelected: async () => [] },
  smartFolder: {
    getAll: async () => { folderCalls.push({ method:'getAll' });
      return (await (await fetch('/fixture/state')).json()).smartFolders; },
    getRules: async () => { folderCalls.push({ method:'getRules' });
      return { tags: { methods: ['contain'], valueType: 'array' } }; },
    create: async options => { folderCalls.push({ method:'create',options });
      await fetch('/fixture/smartfolders', { method:'POST',body:JSON.stringify(options) }); return options; } }
};
window.fixture = { folderCalls, setTheme(theme) { eagle.app.theme = theme; themeListener?.(theme); } };
addEventListener('load', async () => {
  await window.loadRun('fixture-'+count);
  document.querySelector('[data-view="'+(params.get('view') || 'compare')+'"]').click();
  if (params.has('info')) document.querySelector('#toggleInfo').click();
  if (params.has('focus')) document.querySelectorAll('#unitStrip [data-unit-index]')[Number(params.get('focus'))]?.click();
  if (params.has('live')) {
    const { ensureSmartFolders } = await import('./live-writeback.js'); await ensureSmartFolders(eagle, localStorage);
  }
  if (params.has('reject')) {
    const saved = new Promise(resolve => addEventListener('culling:decision-rendered',resolve,{once:true}));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'3',bubbles:true})); await saved;
  }
  if (params.has('finish')) document.querySelector('#openFinish').click();
  window.fixture.ready = true;
});
`;
const images = new Map();
async function preview(unitId) {
  if (images.has(unitId)) return images.get(unitId);
  const n = Number(unitId.split('-').at(-1)) || 1;
  const svg = `<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#668eac"/><stop offset="1" stop-color="#e7c5ad"/></linearGradient>
    <linearGradient id="sea" x2="0" y2="1"><stop stop-color="#3e7889"/><stop offset="1" stop-color="#1a475e"/></linearGradient></defs>
    <rect width="1200" height="800" fill="url(#sky)"/><circle cx="980" cy="170" r="65" fill="#f2dcb0"/>
    <path d="M0 390 Q300 365 600 390 T1200 390 V800 H0Z" fill="url(#sea)"/>
    <path d="M0 700 Q400 500 1200 610 V800 H0Z" fill="#c6b697"/>
    <g transform="translate(${420 + n * 18},290) rotate(${(n % 4) * 2})"><ellipse cx="0" cy="55" rx="42" ry="54" fill="#775a50"/>
    <path d="M-40 100 Q0 80 40 100 L78 310 L-80 310Z" fill="#e7d5c9"/><path d="M-40 295 L-56 450 M40 295 L65 448"
    stroke="#775a50" stroke-width="27"/><path d="M-38 115 L-110 250 M38 115 L115 180" stroke="#b79e8f" stroke-width="23"/></g>
    <text x="28" y="770" fill="#f7eee1" font-size="25">模拟照片 ${n} · 仅用于布局验收</text></svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg().toBuffer(); images.set(unitId, image); return image;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'eagle-culling', contractVersion: 1 });
    if (url.pathname === '/fixture/state') return json(res, 200, { items: [...items.values()],
      originals: [...originals.values()], writes, smartFolders });
    if (url.pathname === '/fixture/smartfolders') { smartFolders.push(await readBody(req)); return json(res, 200, {}); }
    if (url.pathname === '/api/v2/library/info') return json(res, 200, { status: 'success', data: { path: '/fake.library' } });
    if (url.pathname === '/api/v2/item/info') return json(res, 200, { status: 'success', data: items.get(url.searchParams.get('id')) });
    if (url.pathname === '/api/v2/item/update' && req.method === 'POST') {
      const body = await readBody(req); const item = items.get(body.id);
      if (!item) return json(res, 404, { error: 'unknown item' });
      writes.push(body); Object.assign(item, body); return json(res, 200, { status: 'success', data: item });
    }
    if (url.pathname === '/api/feedback/catalog') return json(res, 200, { rules: [], reasons: [
      { id: 'R-P-EYES', label: '闭眼', ruleIds: [] }, { id: 'R-G-BLUR', label: '模糊', ruleIds: [] },
      { id: 'R-COMPOSITION', label: '构图', ruleIds: [] }
    ] });
    if (url.pathname === '/runs') return json(res, 200, { runs: [], page: {} });
    const result = url.pathname.match(/^\/runs\/([^/]+)\/results$/);
    if (result) return json(res, 200, await store.get(result[1]));
    const run = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (run) return json(res, 200, await store.getRun(run[1]));
    const image = url.pathname.match(/^\/runs\/([^/]+)\/(?:preview|detail|face|focus-crop|native)\/([^/]+)/);
    if (image) {
      if (req.method === 'POST') return json(res, 200, {});
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(await preview(decodeURIComponent(image[2])));
    }
    if (await handleReviewRoute(req, res, ctx)) return;
    if (url.pathname === '/fixture-boot.js') { res.writeHead(200, { 'content-type': types['.js'] }); return res.end(boot); }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return json(res, 404, {});
    let content = await readFile(file);
    if (relative === 'index.html') content = content.toString().replace('<head>', '<head><script src="fixture-boot.js"></script>');
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(content);
  } catch (error) { json(res, 500, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Review fixture: http://127.0.0.1:${port}/?count=4&theme=DARK`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
