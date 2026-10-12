import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 43441;
const states = ['offline', 'starting', 'none', 'selected', 'folder', 'running', 'completed', 'settings', 'history',
  'inspector-result', 'inspector-empty', 'inspector-offline'];
const template = JSON.parse(await readFile(path.join(root, 'test/fixtures/review/results.json'), 'utf8'));
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function run(state, index = 0) {
  return { id: index ? `run-fixture-${index}` : 'run-fixture', status: state === 'running' ? 'running' : 'completed',
    startedAt: '2026-10-12T08:00:00Z', scope: { label: index ? `旅行 ${index}` : '旅行照片' },
    libraryPath: '/fixture.library', groupCount: 12, itemCount: 48, selectedCount: 8, rejectedCount: 6,
    progress: { stage: 'focus', completed: 30, total: 48, overallPercent: 65, elapsedSeconds: 120, remainingSeconds: 80 } };
}
function injection(state, theme, selectedCount) {
  return `<script>
const fixtureState=${JSON.stringify(state)}, fixtureTheme=${JSON.stringify(theme)};
localStorage.setItem('eagle-culling-base',location.origin); localStorage.setItem('eagle-culling-autostart','0');
localStorage.setItem('eagle-culling-auto-update','false'); localStorage.setItem('eagle-culling-welcome-dismissed','1');
const events={}, notices=[];
window.fixture={selectedCount:${selectedCount},folder:fixtureState==='folder',theme:fixtureTheme,notices,
setSelection(n){this.selectedCount=n;this.folder=false;},setFolder(enabled){this.selectedCount=0;this.folder=enabled;},
setTheme(theme){this.theme=theme;events.ThemeChanged?.(theme);},hide(){events.PluginHide?.();},show(){events.PluginShow?.();},
changeLibrary(){events.LibraryChanged?.('/fixture.library');}};
window.eagle={app:{theme:fixtureTheme},library:{path:'/fixture.library',name:'示例资源库'},
item:{countSelected:async()=>fixture.selectedCount,countAll:async()=>48,count:async()=>24,
getSelected:async()=>fixtureState.startsWith('inspector')?[{id:'photo'}]:
Array.from({length:fixture.selectedCount},(_,i)=>({id:'photo-'+i})),
get:async()=>Array.from({length:24},(_,i)=>({id:'photo-'+i}))},folder:{getSelected:async()=>fixture.folder?[{id:'folder',name:'旅行'}]:[]},
notification:{show:async row=>notices.push(row)},
window:{show:async()=>{},hide:async()=>{},maximize:async()=>{},unmaximize:async()=>{},setSize:async()=>{}},
smartFolder:{create:async()=>{throw new Error('fixture is read only');}}};
for(const event of ['PluginCreate','PluginRun','PluginShow','PluginHide','LibraryChanged','ThemeChanged'])
  eagle['on'+event]=callback=>{events[event]=callback;};
const nativeFetch=window.fetch.bind(window); window.fetch=(input,options)=>{
const url=new URL(typeof input==='string'?input:input.url,location.href);
if(url.origin===location.origin){url.searchParams.set('fixture',fixtureState);return nativeFetch(url,options);} throw new
  Error('fixture only');};
window.addEventListener('load',()=>{events.PluginShow?.();setTimeout(()=>{
if(fixtureState==='settings')document.querySelector('#openSettings')?.click();
if(fixtureState==='history')document.querySelector('#allRuns')?.click();
if(fixtureState==='starting'){const
  h=document.querySelector('#health');h.textContent='启动中';h.dataset.state='starting';h.title='正在等待服务启动';
document.querySelector('#serviceHint').textContent='启动中…';}
},150);});
</script>`;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`), state = url.searchParams.get('fixture') ||
      url.searchParams.get('state') || 'selected';
    if (url.pathname === '/lab') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Panel fixture</title>
<label>状态 <select id="state">${states.map(s => `<option>${s}</option>`).join('')}</select></label>
<label>主题 <select id="theme"><option>DARK</option><option>LIGHT</option></select></label>
<label>选中 <input id="count" type="number" value="8" min="0"></label><button id="switch">切换</button>
<p>仅假 Eagle / 假服务；通知记录可在 iframe 的 fixture.notices 查看。</p>
<iframe id="frame" style="width:420px;height:600px;border:1px solid"></iframe>
<script>function update(){frame.src='/?state='+state.value+'&theme='+theme.value+'&n='+count.value;}
document.querySelector('#switch').onclick=update;update();</script>`); return;
    }
    if (url.pathname === '/health') return json(res, ['offline', 'starting', 'inspector-offline'].includes(state) ? 503 : 200,
      { service: 'eagle-culling', ok: true, activeRunId: state === 'running' ? 'run-fixture' : null });
    if (url.pathname === '/runs/status') return json(res, 200, { active: state === 'running' ? run(state) : null, recent: [] });
    if (url.pathname === '/runs') {
      if (req.method === 'POST') return json(res, 202, run('completed'));
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const rows = state === 'none' ? [] : Array.from({ length: 6 }, (_, i) => run(state, i));
      return json(res, 200, { runs: rows.slice(cursor, cursor + 4), page: { nextCursor: cursor + 4 < rows.length ? String(cursor +
        4) : null } });
    }
    if (/^\/runs\/[^/]+$/.test(url.pathname)) return json(res, 200, run(state));
    if (url.pathname.endsWith('/cancel')) return json(res, 200, { ...run(state), status: 'cancelled' });
    if (url.pathname.endsWith('/results')) return json(res, 200, { ...template, run: run('completed') });
    if (url.pathname.endsWith('/decisions')) return json(res, 200, { decisions: [] });
    if (url.pathname === '/api/feedback/catalog') return json(res, 200, { reasons: [], rules: [] });
    if (url.pathname.includes('/learning/')) return json(res, 200, { config: {}, snapshots: [], profileId: 'default' });
    if (url.pathname === '/update/status') return json(res, 200, { currentVersion: 'v1.2.5', hasUpdate: false, canUpdate: false,
      canRollback: false });
    if (url.pathname.startsWith('/items/')) {
      if (state === 'inspector-offline') return json(res, 503, { error: 'offline' });
      if (state === 'inspector-empty') return json(res, 404, { error: '尚未分析，在插件中分析后显示' });
      return json(res, 200, { action: 'selected', suggested: 'selected', humanDecided: false, rank: 1, groupSize: 4,
        score: .86, quality: .78, focus: '清晰', eyeSharpness: 140, flags: [], reasons: ['综合分最高', '曝光正常'], runName: '旅行照片',
          analyzedAt: '2026-10-12T08:00:00Z' });
    }
    let relative = url.pathname === '/' ? (state.startsWith('inspector') ? 'src/inspector/index.html' : 'src/plugin/index.html')
      : url.pathname.startsWith('/src/') ? url.pathname.slice(1) : `src/plugin${url.pathname}`;
    if (!/^(?:src\/plugin|src\/inspector)\//.test(relative)) return json(res, 404, { error: 'not found' });
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.join(root, 'src') + path.sep)) return json(res, 404, { error: 'not found' });
    let bytes = await readFile(file);
    const ext = path.extname(file);
    if (ext === '.html') {
      let html = bytes.toString();
      // Absolute module URLs let the root inspector preview retain ../plugin imports.
      const prefix = relative.includes('/inspector/') ? '/src/inspector/' : '/src/plugin/';
      html = html.replace(/(src|href)="(?!\/|http)([^"]+)"/g, (_, attr, value) => `${attr}="${prefix}${value}"`);
      const count = Number(url.searchParams.get('n') || (state === 'selected' ? 8 : 0));
      const mock = injection(state, url.searchParams.get('theme') || 'DARK', count);
      html = html.replace('</head>', `${mock}\n</head>`);
      bytes = Buffer.from(html);
    }
    res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.png': 'image/png' }[ext] || 'application/octet-stream' }); res.end(bytes);
  } catch (error) { json(res, 404, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Panel fixture: http://127.0.0.1:${port}/lab`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
