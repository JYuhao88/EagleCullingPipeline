import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 43441;
const states = ['offline', 'starting', 'none', 'selected', 'folder', 'running', 'completed', 'settings', 'history',
  'inspector-result', 'inspector-empty', 'inspector-offline'];
const template = JSON.parse(await readFile(path.join(root, 'test/fixtures/review/results.json'), 'utf8'));
const FLAGS = [[], [], ['eyes-closed'], [], ['blurry'], [], ['overexposed'], [], ['possibly-blurry'], ['underexposed']];
const ACTION_STARS = { selected: 5, candidate: 3, rejected: 1, clear: 0 };
const queueRows = [];
// Group 3 folds into four moments: ranks 1, 2, 4 | 3, 5 | 6 | 7, 8, 9.
const FIXTURE_MOMENTS = [[1, 3, true], [1, 3, false], [2, 2, true], [1, 3, false], [2, 2, false], [3, 1, true],
  [4, 3, true], [4, 3, false], [4, 3, false]].map(([index, size, lead]) => ({ index, size, lead }));
for (let g = 0, n = 0; g < 20; g++) {
  const size = [1, 3, 2, 9, 5][g % 5];
  for (let r = 1; r <= size; r++, n++) {
    const score = Math.round((0.9 - r * 0.07 - (g % 7) * 0.03) * 100) / 100;
    queueRows.push({ unitId: `unit-${n}`, primaryItemId: `photo-${n}`, fileName: `IMG_${String(4100 + n)}.${['JPG', 'CR3', 'HEIC'][n % 3]}`,
      itemIds: [`photo-${n}`], groupId: `group-${g}`, groupIndex: g, rank: r, groupSize: size,
      suggested: r === 1 ? 'selected' : r >= 4 || FLAGS[n % 10].length ? 'rejected' : 'candidate', action: null, human: null,
      flags: FLAGS[n % 10], confidence: g % 4 === 1 ? 'low' : 'high', score, margin: g % 6 === 2 ? 0 : 0.05,
      reasons: r === 1 ? ['综合分最高', '眼神清晰'] : ['不如本组第一张'] });
  }
}
for (const row of queueRows) row.action = row.suggested;
const adjustments = {};
let writebackAvailable = false;
function photo(id) {
  const n = Number(id.split('-').pop()) || 0, hue = (n * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000"><defs><linearGradient id="g" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,22%)"/></linearGradient></defs>
<rect width="1500" height="1000" fill="url(#g)"/><circle cx="${500 + (n % 5) * 120}" cy="460" r="210" fill="hsl(${hue},30%,85%)"/>
<text x="60" y="940" font-size="72" fill="#fff" font-family="sans-serif">${id}</text></svg>`;
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, x-eagle-stars' });
  res.end(status === 204 ? undefined : JSON.stringify(value));
}
function run(state, index = 0) {
  return { id: index ? `run-fixture-${index}` : 'run-fixture', status: state === 'running' ? 'running' : 'completed',
    startedAt: '2026-10-12T08:00:00Z', scope: { label: index ? `旅行 ${index}` : '旅行照片' },
    libraryPath: '/fixture.library', groupCount: 12, itemCount: 48, selectedCount: 8, rejectedCount: 6,
    progress: { stage: 'focus', completed: 30, total: 48, overallPercent: 65, elapsedSeconds: 120, remainingSeconds: 80 } };
}
function injection(state, theme, selectedCount, fakeEagle = false) {
  const itemNames = Object.fromEntries(queueRows.flatMap(row =>
    row.itemIds.map(id => [id, row.fileName || id])));
  const eagleHost = fakeEagle ? `
const fixtureItemNames=${JSON.stringify(itemNames)}, calls=[], stars=Object.create(null);
for(const id of Object.keys(fixtureItemNames))stars[id]=0;
let selectedIds=Array.from({length:${selectedCount}},(_,i)=>'photo-'+i);
let windowBounds={x:120,y:90,width:960,height:640},alwaysOnTop=false,maximized=false,windowVisible=true;
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const record=(method,...args)=>calls.push({method,args:copy(args)});
const normalizeIds=ids=>[...new Set((Array.isArray(ids)?ids:[]).map(value=>value?.id||value).filter(id=>id in fixtureItemNames))];
const selectInEagle=ids=>{selectedIds=normalizeIds(ids);fixture.selectedCount=selectedIds.length;return [...selectedIds];};
const fakeItem=id=>{
  let value=Number(stars[id])||0;
  return {id,name:fixtureItemNames[id]||id,get star(){return value;},set star(next){value=Number(next)||0;},
    async save(){stars[id]=value;record('item.save',id,value);}};
};
const itemsFor=ids=>normalizeIds(ids).map(fakeItem);
fixture.setSelection=n=>selectInEagle(Array.from({length:n},(_,i)=>'photo-'+i));
window.eagle={app:{theme:fixtureTheme,isDarkColors:async()=>['GRAY','DARK','BLUE','PURPLE'].includes(fixtureTheme)},
library:{path:'/fixture.library',name:'示例资源库'},
item:{getSelected:async()=>itemsFor(selectedIds),countSelected:async()=>selectedIds.length,
select:async ids=>{record('item.select',ids);return selectInEagle(ids);},
getByIds:async ids=>itemsFor(ids),get:async options=>itemsFor(options?.ids||Object.keys(fixtureItemNames).slice(0,24)),
countAll:async()=>Object.keys(fixtureItemNames).length,count:async()=>24},
folder:{getSelected:async()=>fixture.folder?[{id:'folder',name:'旅行'}]:[]},
notification:{show:async row=>notices.push(row)},
window:{getBounds:async()=>{record('window.getBounds');return copy(windowBounds);},
setBounds:async bounds=>{record('window.setBounds',bounds);windowBounds={...windowBounds,...copy(bounds)};},
setAlwaysOnTop:async value=>{record('window.setAlwaysOnTop',Boolean(value));alwaysOnTop=Boolean(value);},
isAlwaysOnTop:async()=>{record('window.isAlwaysOnTop');return alwaysOnTop;},
getSize:async()=>{record('window.getSize');return[windowBounds.width,windowBounds.height];},
setSize:async(width,height)=>{record('window.setSize',width,height);windowBounds={...windowBounds,width,height};},
show:async()=>{record('window.show');windowVisible=true;},hide:async()=>{record('window.hide');windowVisible=false;},
showInactive:async()=>{record('window.showInactive');windowVisible=true;},
maximize:async()=>{record('window.maximize');maximized=true;},unmaximize:async()=>{record('window.unmaximize');maximized=false;},
isMaximized:async()=>{record('window.isMaximized');return maximized;}},
screen:{getPrimaryDisplay:async()=>({workArea:{x:0,y:25,width:1512,height:920},workAreaSize:{width:1512,height:920}})},
smartFolder:{create:async()=>{throw new Error('fixture is read only');}}};
window.__fakeEagle={calls,stars,setStar(id,n){if(id in stars)stars[id]=Number(n)||0;},
select(ids){return selectInEagle(ids);},originalBounds:copy(windowBounds)};
` : `
window.eagle={app:{theme:fixtureTheme},library:{path:'/fixture.library',name:'示例资源库'},
item:{countSelected:async()=>fixture.selectedCount,countAll:async()=>48,count:async()=>24,
getSelected:async()=>fixtureState.startsWith('inspector')?[{id:'photo-6',star:5}]:
Array.from({length:fixture.selectedCount},(_,i)=>({id:'photo-'+i})),
select:async ids=>{fixture.selectedCount=ids.length;},
get:async()=>Array.from({length:24},(_,i)=>({id:'photo-'+i}))},folder:{getSelected:async()=>fixture.folder?[{id:'folder',name:'旅行'}]:[]},
notification:{show:async row=>notices.push(row)},
window:{show:async()=>{},hide:async()=>{},maximize:async()=>{},unmaximize:async()=>{},setSize:async()=>{}},
smartFolder:{create:async()=>{throw new Error('fixture is read only');}}};
`;
  return `${fakeEagle ? '<link rel="icon" href="data:,">' : ''}<script>
const fixtureState=${JSON.stringify(state)}, fixtureTheme=${JSON.stringify(theme)};
localStorage.setItem('eagle-culling-base',location.origin); localStorage.setItem('eagle-culling-autostart','0');
localStorage.setItem('eagle-culling-auto-update','false'); localStorage.setItem('eagle-culling-welcome-dismissed','1');
const events={}, notices=[], fire=(event,value)=>(events[event]||[]).forEach(callback=>callback(value));
window.fixture={selectedCount:${selectedCount},folder:fixtureState==='folder',theme:fixtureTheme,notices,
setSelection(n){this.selectedCount=n;this.folder=false;},setFolder(enabled){this.selectedCount=0;this.folder=enabled;},
setTheme(theme){this.theme=theme;fire('ThemeChanged',theme);},
hide(){sessionStorage.setItem('fixture-hidden','1');fire('PluginHide');},
show(){sessionStorage.removeItem('fixture-hidden');fire('PluginShow');},
run(){if(sessionStorage.getItem('fixture-hidden'))this.show();fire('PluginRun');},
changeLibrary(){fire('LibraryChanged','/fixture.library');}};
${eagleHost}
for(const event of ['PluginCreate','PluginRun','PluginShow','PluginHide','LibraryChanged','ThemeChanged'])
  eagle['on'+event]=${fakeEagle ? '()=>{}' : 'callback=>{(events[event]||=[]).push(callback);}'};
const nativeFetch=window.fetch.bind(window); window.fetch=(input,options)=>{
const url=new URL(typeof input==='string'?input:input.url,location.href);
if(url.origin===location.origin){url.searchParams.set('fixture',fixtureState);return nativeFetch(url,options);} throw new
  Error('fixture only');};
// Module init and the first health check race the load event; retry until the target view is shown.
const targets={settings:['#openSettings','#panelSettings'],history:['#allRuns','#historyView']};
window.addEventListener('load',()=>{if(!sessionStorage.getItem('fixture-hidden'))fire('PluginShow');let tries=0;const open=()=>{
const target=targets[fixtureState];
if(target){const view=document.querySelector(target[1]);if(view&&!view.hidden&&document.querySelector('#health')?.dataset.state===
  'connected')return;document.querySelector(target[0])?.click();}
if(fixtureState==='starting'){const
  h=document.querySelector('#health');h.textContent='启动中';h.dataset.state='starting';h.title='正在等待服务启动';
document.querySelector('#serviceHint').textContent='启动中…';}
if(++tries<40&&(target||fixtureState==='starting'))setTimeout(open,100);};setTimeout(open,50);});
</script>`;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`), state = url.searchParams.get('fixture') ||
      url.searchParams.get('state') || 'selected';
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (url.pathname === '/lab') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Panel fixture</title>
<label>状态 <select id="state">${states.map(s => `<option>${s}</option>`).join('')}</select></label>
<label>主题 <select id="theme"><option>DARK</option><option>LIGHT</option></select></label>
<label>选中 <input id="count" type="number" value="8" min="0"></label><button id="switch">切换</button>
<p>仅假 Eagle / 假服务；通知记录可在 iframe 的 fixture.notices 查看。</p>
<iframe id="frame" style="width:420px;height:600px;border:1px solid"></iframe>
<script>const initial=new URLSearchParams(location.search);
for(const [id,key] of [['state','state'],['theme','theme'],['count','n']])
  if(initial.has(key))document.getElementById(id).value=initial.get(key);
// Same-origin wrapper for screenshots: /lab?bare=1&state=settings&w=420&h=900
const frame=document.getElementById('frame'), field=id=>document.getElementById(id);
function update(){frame.src='/?state='+field('state').value+'&theme='+field('theme').value+'&n='+field('count').value;}
field('switch').onclick=update;update();
if(initial.has('bare')){document.body.style.margin='0';for(const node of [...document.body.children])
  if(node!==frame&&node.tagName!=='SCRIPT')node.hidden=true;frame.style.border='0';frame.style.display='block';}
if(initial.has('w'))frame.style.width=initial.get('w')+'px';
if(initial.has('h'))frame.style.height=initial.get('h')+'px';</script>`); return;
    }
    if (url.pathname === '/ui/wide') {
      if (req.method === 'POST') return json(res, 200, { boot: 'fixture', seq: 0 });
      setTimeout(() => json(res, 200, { boot: 'fixture', seq: 0 }), url.searchParams.has('boot') ? 25000 : 0); return;
    }
    if (url.pathname === '/health') return json(res, ['offline', 'starting', 'inspector-offline'].includes(state) ? 503 : 200,
      { service: 'eagle-culling', ok: true, activeRunId: state === 'running' ? 'run-fixture' : null });
    if (url.pathname === '/runs/status') return json(res, 200, { active: state === 'running' ? run(state) : null, recent: [],
      prefetch: { id: 'run-prefetch', status: 'completed', startedAt: '2026-10-12T01:10:00Z', finishedAt: '2026-10-12T01:24:00Z',
        itemCount: 126 } });
    if (url.pathname === '/cache/usage') return json(res, 200, { totalBytes: 1.8 * 1024 ** 3, maxBytes: 5 * 1024 ** 3,
      categories: [{ name: 'previews', label: '预览', bytes: 1.3 * 1024 ** 3, files: 9800 },
        { name: 'results-v2', label: '分析结果', bytes: 0.2 * 1024 ** 3, files: 9800 }] });
    if (url.pathname === '/cache/limit' || url.pathname === '/cache/clear')
      return json(res, 200, { totalBytes: 0.4 * 1024 ** 3, maxBytes: 5 * 1024 ** 3, categories: [] });
    if (url.pathname === '/runs') {
      if (req.method === 'POST') return json(res, 202, run('completed'));
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const rows = state === 'none' ? [] : Array.from({ length: 6 }, (_, i) => run(state, i));
      return json(res, 200, { runs: rows.slice(cursor, cursor + 4), page: { nextCursor: cursor + 4 < rows.length ? String(cursor +
        4) : null } });
    }
    const queueMatch = url.pathname.match(/^\/runs\/[^/]+\/(queue|adjustments|preview|detail|display|focus-points)(?:\/([^/]+))?$/);
    if (queueMatch?.[1] === 'queue') return json(res, 200, { mode: 'all', queue: queueRows, items: queueRows,
      order: queueRows.map(row => row.unitId), counts: {}, total: queueRows.length });
    if (queueMatch?.[1] === 'adjustments') {
      const id = queueMatch[2] && decodeURIComponent(queueMatch[2]);
      if (req.method === 'PUT') {
        let body = ''; for await (const chunk of req) body += chunk;
        adjustments[id] = JSON.parse(body || '{}'); return json(res, 200, adjustments[id]);
      }
      return json(res, 200, id ? adjustments[id] || {} : adjustments);
    }
    if (queueMatch?.[1] === 'focus-points') return json(res, 200, queueMatch[2]?.endsWith('6')
      ? { source: 'sony', width: 7008, height: 4672, areas: [{ box: [0.5562, 0.4259, 0.6625, 0.5531], kind: 'frame', inFocus: true }] }
      : { source: null, width: 6000, height: 4000, areas: [] });
    if (queueMatch?.[1] === 'display' && process.env.ECP_FIXTURE_PHOTO) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' });
      res.end(await readFile(process.env.ECP_FIXTURE_PHOTO)); return;
    }
    if (queueMatch && ["preview", "detail", "display"].includes(queueMatch[1])) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
      res.end(photo(decodeURIComponent(queueMatch[2] || ''))); return;
    }
    if (url.pathname.endsWith('/decisions') && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const posted = Array.isArray(parsed) ? parsed : parsed.decisions || [];
      const decisions = [];
      const eagleStars = [];
      for (const row of posted) {
        const target = queueRows.find(item => item.unitId === row.unitId);
        if (!target) continue;
        target.human = row.clear ? null : row.action; target.action = target.human || target.suggested;
        if (!row.clear) decisions.push({ unitId: target.unitId, action: target.human, source: 'human' });
        if (req.headers['x-eagle-stars'] === '1') {
          const star = row.clear ? 0 : ACTION_STARS[row.action];
          if (star !== undefined) for (const id of target.itemIds || [target.primaryItemId]) eagleStars.push({ id, star });
        }
      }
      return json(res, 200, { decisions, ...(req.headers['x-eagle-stars'] === '1' ? { eagleStars } : {}) });
    }
    if (/^\/runs\/[^/]+$/.test(url.pathname)) return json(res, 200, run(state));
    if (url.pathname.endsWith('/cancel')) return json(res, 200, { ...run(state), status: 'cancelled' });
    if (url.pathname.endsWith('/results'))
      return json(res, 200, { ...template, run: run('completed'), writebackAvailable });
    if (url.pathname.endsWith('/apply') && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body || '{}');
      if (request.moveRejectedToTrash && request.confirm !== 'MOVE_TO_TRASH')
        return json(res, 400, { error: '请输入 MOVE_TO_TRASH' });
      if (request.apply) writebackAvailable = true;
      return json(res, 200, { summary: { changed: 0, unchanged: template.units.length,
        addedTags: 0, removedTags: 0, tags: {}, byAction: {} }, results: [],
      warning: '假服务预览，不修改 Eagle。' });
    }
    if (url.pathname.endsWith('/trash-rejected') && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body || '{}');
      if (request.apply && request.confirm !== 'MOVE_TO_TRASH') return json(res, 400, { error: '请输入 MOVE_TO_TRASH' });
      const rows = queueRows.filter(row => row.human === 'rejected');
      const ids = rows.flatMap(row => row.itemIds || [row.primaryItemId]);
      return json(res, 200, { dryRun: !request.apply, verified: true, units: rows.length, count: ids.length, skipped: 0,
        files: ids.slice(0, 50).map(id => `${id}.jpg`), ...(request.apply ? { trash: ids.map(id => ({ id, ok: true })) } : {}) });
    }
    if (url.pathname.endsWith('/writeback/revert') && req.method === 'POST') {
      writebackAvailable = false;
      return json(res, 200, { summary: { unchanged: template.units.length }, results: [] });
    }
    if (url.pathname.endsWith('/report')) {
      if (url.searchParams.get('format') !== 'csv') return json(res, 200, { results: [] });
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
      res.end('id,action\n'); return;
    }
    if (url.pathname.endsWith('/decisions')) return json(res, 200, { decisions: [] });
    if (url.pathname === '/api/feedback/catalog') return json(res, 200, { reasons: [], rules: [] });
    if (url.pathname.includes('/learning/')) return json(res, 200, { config: {}, snapshots: [], profileId: 'default' });
    if (url.pathname === '/update/status') return json(res, 200, { currentVersion: 'v1.2.5', hasUpdate: false, canUpdate: false,
      canRollback: false });
    const itemDecision = url.pathname.match(/^\/items\/([^/]+)\/decision$/);
    if (itemDecision && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body || '{}');
      const itemId = decodeURIComponent(itemDecision[1]);
      const target = queueRows.find(row => (row.itemIds || [row.primaryItemId]).includes(itemId));
      if (!target) return json(res, 404, { error: 'item not found' });
      const clear = request.action === 'clear';
      if (request.via === 'eagle-star' && (clear ? !target.human : target.human === request.action)) {
        return json(res, 200, { runId: 'run-fixture', unitId: target.unitId, unchanged: true });
      }
      target.human = clear ? null : request.action;
      target.action = target.human || target.suggested;
      const decisions = clear ? [] : [{ unitId: target.unitId, action: target.human, source: 'human' }];
      return json(res, 200, { runId: 'run-fixture', unitId: target.unitId, decisions });
    }
    if (url.pathname.startsWith('/items/')) {
      if (state === 'inspector-offline') return json(res, 503, { error: 'offline' });
      if (state === 'inspector-empty') return json(res, 404, { error: '尚未分析，在插件中分析后显示' });
      return json(res, 200, { action: 'selected', suggested: 'selected', humanDecided: false, rank: 1, groupSize: 9,
        score: .86, quality: .78, focus: '清晰', eyeSharpness: 140, flags: [], reasons: ['综合分最高', '曝光正常'], runName: '旅行照片',
          analyzedAt: '2026-10-12T08:00:00Z', runId: 'run-fixture', unitId: 'unit-6', groupId: 'group-3', groupIndex: 3,
          groupConfidence: 'high', groupItemIds: queueRows.filter(row => row.groupId === 'group-3').map(row => row.primaryItemId),
          groupMembers: queueRows.filter(row => row.groupId === 'group-3').map(row => ({ unitId: row.unitId,
            itemIds: row.itemIds, rank: row.rank, suggested: row.suggested, human: row.human, flags: row.flags,
            metrics: { score: row.score, quality: .8 - row.rank * .04, sharpness: .3 - row.rank * .03 * (row.rank % 2 + 1),
              eye: row.flags.includes('eyes-closed') ? null : 140 - row.rank * 12, exposure: .85 + (row.rank % 3) * .04,
              clipped: row.rank * .004 }, moment: FIXTURE_MOMENTS[row.rank - 1] })) });
    }
    let relative = url.pathname === '/' ? (state.startsWith('inspector') ? 'src/plugin/inspector/index.html' : 'src/plugin/index.html')
      : url.pathname.startsWith('/src/') ? url.pathname.slice(1) : `src/plugin${url.pathname}`;
    if (!/^(?:src\/plugin|src\/inspector)\//.test(relative)) return json(res, 404, { error: 'not found' });
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.join(root, 'src') + path.sep)) return json(res, 404, { error: 'not found' });
    let bytes = await readFile(file);
    const ext = path.extname(file);
    if (ext === '.html') {
      let html = bytes.toString();
      // Absolute module URLs let pages served from / keep their relative imports.
      const prefix = `/${path.posix.dirname(relative)}/`;
      html = html.replace(/(src|href)="(?!\/|http)([^"]+)"/g, (_, attr, value) => `${attr}="${prefix}${value}"`);
      const count = Number(url.searchParams.get('n') || (state === 'selected' ? 8 : 0));
      const mock = injection(state, url.searchParams.get('theme') || 'DARK', count, url.searchParams.get('eagle') === 'fake');
      html = html.replace('</head>', `${mock}\n</head>`);
      bytes = Buffer.from(html);
    }
    res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.png': 'image/png' }[ext] || 'application/octet-stream' }); res.end(bytes);
  } catch (error) { json(res, 404, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Panel fixture: http://127.0.0.1:${port}/lab`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
