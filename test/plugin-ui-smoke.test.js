import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the plugin preview");
}

test("rendered plugin demo supports Chinese review filtering without browser errors", async (t) => {
  const edgePath = EDGE_PATHS.find(existsSync);
  if (process.platform !== "win32" || !edgePath || typeof WebSocket === "undefined") {
    t.skip("Microsoft Edge with WebSocket support is required for this Windows UI smoke test");
    return;
  }

  const pluginRoot = path.resolve("src/plugin");
  const staticServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.join(pluginRoot, fileName);
    if (!filePath.startsWith(pluginRoot)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(filePath);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filePath)] || "application/octet-stream";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await listen(staticServer);
  const webPort = staticServer.address().port;

  const debugServer = http.createServer();
  await listen(debugServer);
  const debugPort = debugServer.address().port;
  await close(debugServer);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "eagle-plugin-edge-"));
  const browser = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  t.after(async () => {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    await close(staticServer);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find((entry) => entry.type === "page");
  });

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  t.after(() => socket.close());

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const command = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const message = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text);
    return message.result.result.value;
  };

  await command("Runtime.enable");
  await command("Page.enable");
  await command("Page.navigate", { url: `http://127.0.0.1:${webPort}/index.html?demo=1` });
  await waitFor(async () => await evaluate("document.querySelectorAll('.item-row').length") === 4);
  assert.equal(await evaluate("document.querySelector('#service-state').textContent.trim()"), "界面演示数据");
  assert.equal(await evaluate("document.querySelector('.decision-button').disabled"), true);
  assert.equal(await evaluate("document.querySelector('#restore-selected').textContent.includes('旧网格角标')"), true);
  assert.equal(await evaluate("document.body.innerText.includes('RAW/原始格式已作为母片保护')"), true);
  assert.equal(await evaluate("document.body.innerText.includes('AI精选')"), true);
  await evaluate("document.querySelector('[data-action=compare]').click()");
  assert.equal(await evaluate("document.querySelector('#compare-dialog').open"),true);
  assert.equal(await evaluate("document.querySelectorAll('.compare-panel').length"),2);
  assert.equal(await evaluate("document.querySelector('[data-compare-best]').disabled"),true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.compare-image img')).objectFit"),"contain");
  const compareBounds=await evaluate("(()=>{const panels=[...document.querySelectorAll('.compare-image')].map(e=>e.getBoundingClientRect());const dialog=document.querySelector('#compare-dialog').getBoundingClientRect();return {separate:panels[0].right<panels[1].left,inside:panels.every(p=>p.left>=dialog.left && p.right<=dialog.right),height:panels[0].height};})()");
  assert.equal(compareBounds.separate,true);assert.equal(compareBounds.inside,true);assert.ok(compareBounds.height>100);
  const compareLeft=await evaluate("document.querySelector('[data-compare-side=left]').value");
  const compareRight=await evaluate("document.querySelector('[data-compare-side=right]').value");
  assert.notEqual(compareLeft,compareRight);
  await evaluate("document.querySelector('#compare-swap').click()");
  assert.equal(await evaluate("document.querySelector('[data-compare-side=left]').value"),compareRight);
  assert.equal(await evaluate("document.querySelector('[data-compare-side=right]').value"),compareLeft);
  const compareFocus=await evaluate("document.querySelector('.is-focused').dataset.recordId");
  await evaluate("document.querySelector('#compare-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('.is-focused').dataset.recordId"),compareFocus,"comparison must not invoke list shortcuts behind the modal");
  await evaluate("document.querySelector('#compare-close').click()");
  assert.equal(await evaluate("document.querySelector('#compare-dialog').open"),false);
  await waitFor(async()=>await evaluate("document.querySelector('#compare-panels').children.length")===0);

  await evaluate("document.querySelector('[data-filter=selected]').click()" );
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 1);
  await evaluate("document.querySelector('[data-filter=all]').click(); const input=document.querySelector('#search'); input.value='B0001731'; input.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 2);

  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    globalThis.__savedItem = null;
    globalThis.__savedItems = {};
    const tasks = new Map(JSON.parse(sessionStorage.getItem('__mockTaskSnapshot') || '[]'));
    globalThis.__createdTasks = tasks.size;
    globalThis.__tasks = tasks;
    globalThis.__taskEvents = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.port !== '43125') return originalFetch(input, options);
      let value = {};
      const body = options.body ? JSON.parse(options.body) : {};
      if (url.pathname === '/version' && globalThis.__switchAtVersion) {
        globalThis.__switchAtVersion=false;globalThis.eagle.library.path='different-library';
      }
      if (url.pathname === '/tasks' && options.method === 'POST') {
        globalThis.__createdTasks = (globalThis.__createdTasks || 0) + 1;
        value = { ...body, taskId: 'mock-task-'+globalThis.__createdTasks, summary: {total:body.items.length,succeeded:0,skipped:0,failed:0} }; tasks.set(value.taskId, value);
        if (globalThis.__switchAfterUpload) {globalThis.__switchAfterUpload=false;globalThis.eagle.library.path='different-library';}
      } else if (url.pathname === '/tasks') value = {tasks:[...tasks.values()]};
      else if (url.pathname.startsWith('/tasks/')) {
        value = tasks.get(url.pathname.split('/')[2]);
        if (options.method === 'POST') globalThis.__taskEvents.push({taskId:value.taskId,type:value.taskType,action:url.pathname.split('/').at(-1)});
        if (url.pathname.endsWith('/checkpoint')) {
          for (const patch of body.items) Object.assign(value.items.find(item => item.id === patch.itemId), patch);
          value.summary.succeeded = value.items.filter(item => item.status === 'succeeded').length;
        }
        if (url.pathname.endsWith('/complete')) value.status = 'succeeded';
        if (url.pathname.endsWith('/pause')) value.status = 'paused';
        if (url.pathname.endsWith('/resume')) value.status = 'pending';
        if (url.pathname.endsWith('/claim')) {
          if (value.activationPending && body.activate !== true) return new Response(JSON.stringify({error:'explicit activation required'}),{status:409});
          value.execution = {ownerId:body.ownerId};value.status='running';value.activationPending=false;
        }
        if (url.pathname.endsWith('/release')) value.execution = null;
      } else if (url.pathname === '/health') value = globalThis.__mockHealth || {ok:true,service:'eagle-culling'};
      else if (url.pathname === '/version') value = globalThis.__mockVersion || {service:'eagle-culling',apiVersion:1,version:'0.4.0',capabilities:['thumbnail-backup-v1','task-execution-v1','resource-gate-v1','phash-pairwise-v2','task-plan-upload-v1','semantic-analysis-v1','task-plan-staging-v1']};
      else if (url.pathname === '/badge-manifest') value = {items:{}};
      else if (url.pathname === '/analyze') {
        globalThis.__lastEmbeddingRequested = body.includeEmbeddings;
        globalThis.__analysisRequests = (globalThis.__analysisRequests || 0) + 1;
        if (globalThis.__slowAnalysis) {
          globalThis.__slowAnalysis=false;globalThis.__slowAnalysisStarted=true;
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(resolve,5000);
            const abort=()=>{clearTimeout(timer);reject(options.signal.reason);};
            if (options.signal?.aborted) abort();else options.signal?.addEventListener('abort',abort,{once:true});
          });
        }
        value = {items:body.items.map(item=>({...item,qualityScore:88,qualityFlags:[],phash:'0000000000000000',analysisSource:'proxy'})),groups:[]};
        globalThis.__duringAnalysis?.();
      } else if (url.pathname === '/cluster') {globalThis.__lastClusterEmbeddings=body.includeEmbeddings;value = {groups:[]};}
      if (url.pathname.startsWith('/tasks') && options.method === 'POST') sessionStorage.setItem('__mockTaskSnapshot',JSON.stringify([...tasks]));
      if (url.searchParams.get('includeItems') === 'false' && value?.items) {
        const {items,...summary}=value;value=summary;
      }
      return new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
    };
    const selected = [{
      id: "real-1", name: "中文样片", ext: "JPG", filePath: "D:/photo.jpg",
      width: 6000, height: 4000, modifiedAt:1, tags: ["人工标签", "ai:candidate", "ai:paired"],
      folders: ["user-folder"], star: 4, thumbnailURL: ""
    }];
    const catalogue = JSON.parse(sessionStorage.getItem('__mockCatalogue') || 'null') || [...selected, {...selected[0], id:'real-raw', ext:'ARW', tags:['人工RAW','AI原片'], star:2}];
    globalThis.__changeDuringAnalysis = () => {
      const raw = catalogue.find(item=>item.id==='real-raw');
      raw.modifiedAt = 2;raw.tags=['人工最新标签','待复核'];raw.star=5;
    };
    globalThis.eagle = {
      library: {path:'mock-library'},
      onPluginCreate(callback) { setTimeout(callback, 0); },
      item: {
        async get() { return catalogue.map(item => ({...item})); },
        async getAll() { return catalogue.map(item => ({...item})); },
        async getSelected() {
          if (globalThis.__largeSelection) return Array.from({length:8000}, (_,index) => ({...selected[0],id:'photo-'+index,name:'photo'+index}));
          if (globalThis.__includeRaw) return catalogue.map(item=>({...item}));
          return selected.map((item) => ({ ...item }));
        },
        async getById(id) {
          const item = { ...catalogue.find((entry) => entry.id === id) };
          item.save = async function save() {
            if (globalThis.__persistSaved) {
              const original=catalogue.find(entry=>entry.id===id);
              original.tags=[...this.tags];original.modifiedAt++;
              sessionStorage.setItem('__mockCatalogue',JSON.stringify(catalogue));
              globalThis.__prioritySaves=(globalThis.__prioritySaves || 0)+1;
            }
            globalThis.__savedItems[id] = { ...this, save: undefined };
            if (id === 'real-1') globalThis.__savedItem = globalThis.__savedItems[id];
            return true;
          };
          return item;
        },
        async select(ids) { globalThis.__selectedIds = ids; return true; },
        async open(id) { globalThis.__openedId = id; return true; }
      }
    };
  ` });
  await command("Page.navigate", { url: `http://127.0.0.1:${webPort}/index.html` });
  await waitFor(async () => await evaluate("document.querySelectorAll('.item-row').length") === 1);
  await evaluate("document.querySelector('.decision-button[data-action=selected]').click()");
  const saved = await waitFor(async () => await evaluate("globalThis.__savedItem"));
  assert.deepEqual(saved.tags, ["人工标签", "ai:paired", "AI精选"]);
  assert.deepEqual(saved.folders, ["user-folder"]);
  assert.equal(saved.star, 4);
  await waitFor(async () => await evaluate("document.querySelector('#status').textContent.includes('任务完成')"));
  const rawSaved = await evaluate("globalThis.__savedItems['real-raw']");
  assert.deepEqual(rawSaved.tags, ["人工RAW", "AI原片", "AI精选"]);
  assert.equal(rawSaved.star, 2);
  assert.deepEqual(rawSaved.folders, ["user-folder"]);
  const overlay = await evaluate("const r=document.querySelector('.review-overlay'); const s=getComputedStyle(r); ({left:s.left,bottom:s.bottom,text:r.textContent})");
  assert.deepEqual(overlay, {left:"8px",bottom:"8px",text:"精选"});
  await evaluate("const toggle=document.querySelector('#show-review-overlays');toggle.checked=false;toggle.dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.review-overlay')).display"), "none");
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"), 2);
  await evaluate("const semantic=document.querySelector('#semantic-enabled');semantic.checked=true;semantic.dispatchEvent(new Event('change'));globalThis.__includeRaw=true;document.querySelector('#analyze').click()");
  await waitFor(async () => await evaluate("globalThis.__analysisRequests") === 1);
  await waitFor(async () => await evaluate("document.querySelector('#status').textContent.includes('任务完成')"));
  assert.equal(await evaluate("globalThis.__lastEmbeddingRequested"),true);
  assert.equal(await evaluate("globalThis.__lastClusterEmbeddings"),true);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('eagle-culling-queue-config')).includeEmbeddings"),true);
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 2);
  assert.equal(await evaluate("document.body.innerText.includes('不代表 RAW 解码质量或原始动态范围')"), true);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"), 2);
  await evaluate("globalThis.__duringAnalysis=globalThis.__changeDuringAnalysis;document.querySelector('#analyze').click()");
  await waitFor(async () => await evaluate("globalThis.__analysisRequests") === 2);
  await waitFor(async () => await evaluate("document.querySelector('#status').textContent.includes('任务完成')"));
  assert.equal(await evaluate("document.querySelector('[data-record-id=real-raw] .state-badge').dataset.state"),"rejected");
  assert.equal(await evaluate("document.querySelector('[data-record-id=real-raw] .item-meta').textContent.includes('Eagle 5 星')"),true);
  assert.equal(await evaluate("document.querySelector('[data-record-id=real-raw] .reason-list').textContent.includes('缓存分析早于')"),true);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),2);
  await evaluate("window.confirm = () => false; document.querySelector('#restore-selected').click()");
  await waitFor(async () => await evaluate("document.querySelector('#status').textContent.includes('已取消恢复')"));
  const taskCountBeforeMismatch = await evaluate("globalThis.__createdTasks");
  assert.equal(await evaluate("document.querySelector('#plugin-version').textContent"),"0.4.0");
  await evaluate("globalThis.__mockVersion={service:'eagle-culling',apiVersion:1,version:'0.3.0',capabilities:['task-execution-v1']};document.querySelector('#analyze').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#status').textContent.includes('插件 0.4.0 / 服务 0.3.0')"));
  assert.equal(await evaluate("globalThis.__createdTasks"),taskCountBeforeMismatch);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),2);
  await evaluate("document.querySelector('#service-recheck').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#service-state').dataset.state") === "outdated");
  assert.equal(await evaluate("document.querySelector('#service-version').textContent"),"0.3.0");
  assert.equal(await evaluate("document.querySelector('#service-upgrade-help').hidden"),false);
  await evaluate("globalThis.__mockHealth={ok:false,service:'eagle-culling',error:'journal corrupt'};document.querySelector('#service-recheck').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#service-state').dataset.state") === "unhealthy");
  assert.equal(await evaluate("document.querySelector('#service-error').textContent.includes('journal corrupt')"),true);
  assert.equal(await evaluate("document.querySelector('#service-error').textContent.includes('服务未启动')"),false);
  assert.equal(await evaluate("document.querySelector('#service-recheck').disabled"),false);
  assert.equal(await evaluate("globalThis.__createdTasks"),taskCountBeforeMismatch);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),2);
  await evaluate("delete globalThis.__mockHealth");
  await evaluate("document.querySelector('[data-view=settings]').click();document.querySelector('#mode-badge').click()");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.review-overlay')).display"),"none");
  assert.equal(await evaluate("document.querySelector('#show-review-overlays').checked"),true);
  await evaluate("document.querySelector('#mode-native').click()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.review-overlay')).display"),"none");
  assert.equal(await evaluate("document.querySelector('#mode-state').textContent.includes('网格旧角标需单独恢复')"),true);
  assert.equal(await evaluate("globalThis.__createdTasks"),taskCountBeforeMismatch);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),2);
  assert.equal(await evaluate("document.querySelector('.legacy-thumbnail-tools').open"),false);
  await evaluate("document.querySelector('#badges').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#status').textContent.includes('已取消网格角标写入')"));
  await evaluate("document.querySelector('#all-badges').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#status').textContent.includes('已取消全库网格角标写入')"));
  assert.equal(await evaluate("globalThis.__createdTasks"),taskCountBeforeMismatch);
  await evaluate(`globalThis.__reportDownloads=[];
    const reportBlobs=new Map();const oldCreate=URL.createObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=oldCreate(blob);reportBlobs.set(url,blob);return url;};
    HTMLAnchorElement.prototype.click=function(){globalThis.__reportDownloads.push({name:this.download,text:reportBlobs.get(this.href).text()});};
    document.querySelector('#task-report-json').click();`);
  await waitFor(async()=>await evaluate("globalThis.__reportDownloads.length")===1);
  const exportedReport=await evaluate("(async()=>JSON.parse(await globalThis.__reportDownloads[0].text))()");
  assert.equal(exportedReport.counts.total,1);
  assert.equal(exportedReport.counts.affectedFiles,2);
  assert.equal(exportedReport.counts.skipped,1);
  await evaluate("document.querySelector('#task-report-csv').click()");
  await waitFor(async()=>await evaluate("globalThis.__reportDownloads.length")===2);
  assert.ok((await evaluate("(async()=>await globalThis.__reportDownloads[1].text)()")).includes("分析期间项目发生变化"));
  assert.equal(await evaluate("globalThis.__createdTasks"),taskCountBeforeMismatch);
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),2);
  await evaluate("globalThis.__mockVersion=null");
  // Real browser interaction while a request is in flight: the user does not
  // have to manually pause analysis or revisit the task controls.
  await evaluate("globalThis.__duringAnalysis=null;globalThis.__persistSaved=true;globalThis.__slowAnalysis=true;document.querySelector('#analyze').click()");
  await waitFor(async()=>await evaluate("globalThis.__slowAnalysisStarted"));
  await waitFor(async()=>await evaluate("document.querySelector('.decision-button[data-action=selected]').disabled")===false);
  await evaluate("document.querySelector('.decision-button[data-action=selected]').click()");
  await waitFor(async()=>await evaluate("globalThis.__prioritySaves")===2);
  await waitFor(async()=>await evaluate("[...globalThis.__tasks.values()].filter(task=>task.taskType==='analyze-selection').at(-1).status") === "succeeded");
  const priorityEvents=await evaluate("globalThis.__taskEvents");
  const backgroundId=await evaluate("[...globalThis.__tasks.values()].filter(task=>task.taskType==='analyze-selection').at(-1).taskId");
  const pauseIndex=priorityEvents.findIndex(event=>event.taskId===backgroundId && event.action==='pause');
  const releaseIndex=priorityEvents.findIndex((event,index)=>index>pauseIndex && event.taskId===backgroundId && event.action==='release');
  const reviewClaim=priorityEvents.findIndex((event,index)=>index>releaseIndex && event.type==='review-units' && event.action==='claim');
  const reviewRelease=priorityEvents.findIndex((event,index)=>index>reviewClaim && event.type==='review-units' && event.action==='release');
  const resumeIndex=priorityEvents.findIndex((event,index)=>index>reviewRelease && event.taskId===backgroundId && event.action==='resume');
  assert.ok(pauseIndex>=0 && releaseIndex>pauseIndex && reviewClaim>releaseIndex && reviewRelease>reviewClaim && resumeIndex>reviewRelease);
  assert.ok((await evaluate("globalThis.__savedItems['real-raw'].tags")).includes("AI精选"));
  assert.ok((await evaluate("globalThis.__savedItems['real-raw'].tags")).includes("人工最新标签"));
  assert.equal(await evaluate("globalThis.__savedItems['real-raw'].star"),5);
  await evaluate("globalThis.__persistSaved=false");
  const beforeSwitch=await evaluate("globalThis.__createdTasks");
  await evaluate("globalThis.__switchAtVersion=true;document.querySelector('.decision-button[data-action=candidate]').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#status').textContent.includes('旧计划不会写入新资源库')"));
  assert.equal(await evaluate("globalThis.__createdTasks"),beforeSwitch,"library changed during version await: do not even create a plan");
  assert.equal(await evaluate("globalThis.__prioritySaves"),2);
  await evaluate("globalThis.eagle.library.path='mock-library';globalThis.__switchAfterUpload=true;document.querySelector('.decision-button[data-action=candidate]').click()");
  await waitFor(async()=>await evaluate("globalThis.__createdTasks")===beforeSwitch+1);
  await waitFor(async()=>await evaluate("[...globalThis.__tasks.values()].at(-1).status") === "paused");
  assert.equal(await evaluate("[...globalThis.__tasks.values()].at(-1).libraryPath"),"mock-library");
  assert.equal(await evaluate("[...globalThis.__tasks.values()].at(-1).execution || null"),null);
  assert.equal(await evaluate("globalThis.__prioritySaves"),2,"uploaded plan must not execute after a library switch");
  await evaluate("globalThis.eagle.library.path='mock-library'");
  const stagedId=await evaluate("[...globalThis.__tasks.values()].at(-1).taskId");
  await command("Page.navigate",{url:`http://127.0.0.1:${webPort}/index.html?staged-reload`});
  await waitFor(async()=>await evaluate("document.querySelector('#task-current').textContent.includes('待确认启动')"));
  assert.equal(await evaluate("document.querySelector('#task-current').textContent.includes('人工审阅（同步配对）')"),true);
  assert.equal(await evaluate("document.querySelector('#task-resume').disabled"),false);
  assert.equal(await evaluate(`globalThis.__tasks.get(${JSON.stringify(stagedId)}).status`),"paused");
  assert.equal(await evaluate("globalThis.__taskEvents.some(event=>event.action==='claim')"),false,"reopening must not automatically activate an uploaded plan");
  assert.equal(await evaluate("Object.keys(globalThis.__savedItems).length"),0);
  await evaluate("globalThis.__persistSaved=true;document.querySelector('#task-resume').click()");
  await waitFor(async()=>await evaluate(`globalThis.__tasks.get(${JSON.stringify(stagedId)}).status`)==="succeeded");
  assert.equal(await evaluate(`globalThis.__tasks.get(${JSON.stringify(stagedId)}).activationPending`),false);
  assert.equal(await evaluate("globalThis.__prioritySaves"),2);
  assert.ok((await evaluate("globalThis.__savedItems['real-raw'].tags")).includes("AI候选"));
  assert.ok((await evaluate("globalThis.__savedItems['real-raw'].tags")).includes("人工最新标签"));
  assert.equal(await evaluate("globalThis.__savedItems['real-raw'].star"),5);
  await waitFor(async()=>await evaluate("document.querySelector('#task-resume').disabled")===true);
  await evaluate("globalThis.__persistSaved=false");
  await evaluate(`for(let index=0;index<33;index++)globalThis.__tasks.set('archived-'+index,{
    taskId:'archived-'+index,taskType:index===32?'restore-thumbnails':'analyze-selection',status:'succeeded',libraryPath:'mock-library',
    summary:{total:1,succeeded:1,failed:0,skipped:0},items:[{id:'old-photo',status:'succeeded'}]
  });`);
  await waitFor(async()=>await evaluate("document.querySelector('#task-history-page').textContent.includes('2 页')"));
  assert.equal(await evaluate("document.querySelectorAll('#task-history .task-history-row').length"),20);
  await evaluate("document.querySelector('#task-history-next').click()");
  assert.equal(await evaluate("!!document.querySelector('[data-task-id=archived-32]')"),true,"older tasks remain reachable after the first page");
  await evaluate("(()=>{const input=document.querySelector('#task-history-search');input.value='恢复';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal(await evaluate("document.querySelectorAll('#task-history .task-history-row').length"),1);
  await evaluate("document.querySelector('[data-task-id=archived-32]').click()");
  await waitFor(async()=>await evaluate("document.querySelector('#task-current').textContent.includes('恢复原生缩略图 · 已完成')"));
  assert.equal(await evaluate("document.querySelector('#task-resume').disabled"),true);
  await evaluate("(()=>{const input=document.querySelector('#task-history-search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const largeStart = performance.now();
  await evaluate("globalThis.__largeSelection=true; document.querySelector('#inspect').click()");
  await waitFor(async () => await evaluate("document.querySelector('#summary-total').textContent") === "8000");
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 80);
  assert.equal(await evaluate("document.querySelector('#review-page').textContent.includes('100 页')"), true);
  await evaluate("document.querySelector('#review-next').click()");
  assert.equal(await evaluate("document.querySelector('.item-row').dataset.recordId"), "photo-80");
  await evaluate("const input=document.querySelector('#search'); input.value='photo7999'; input.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 1);
  assert.equal(await evaluate("document.querySelector('.item-row').dataset.recordId"), "photo-7999");
  t.diagnostic(`8,000-item rendered review plus paging/search: ${Math.round(performance.now()-largeStart)}ms`);
  const draftCheck = await evaluate(`(async()=>{
    const {PlanDraftStore}=await import('./plan-drafts.js');
    const draft={taskId:'browser-draft',input:{libraryPath:'mock-library',taskType:'analyze-selection',items:Array.from({length:8000},(_,id)=>({id:String(id),result:'中文'.repeat(100)}))}};
    await new PlanDraftStore().put(draft);
    const reopened=new PlanDraftStore();
    const loaded=await reopened.get(draft.taskId);
    const result={count:loaded.input.items.length,lastId:loaded.input.items.at(-1).id,listed:(await reopened.list()).length};
    await reopened.remove(draft.taskId);
    result.remaining=(await new PlanDraftStore().list()).length;
    return result;
  })()`);
  assert.deepEqual(draftCheck,{count:8000,lastId:'7999',listed:1,remaining:0});
  assert.deepEqual(exceptions, []);
});
