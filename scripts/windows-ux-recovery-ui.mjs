// Emergency recovery QA: GET-only against the user service; all simulated POSTs are intercepted.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
if (process.platform !== 'win32') throw new Error('Windows UI QA only');
const root = path.resolve('..'), qa = path.join(root, 'qa', 'recovery-ux');
await mkdir(qa, { recursive: true });
const { chromium } = await import(pathToFileURL(path.join(root, 'qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
const page = await browser.newPage();
const base = 'http://127.0.0.1:43125';
const report = { status: 'running', realUserServicePosts: 0, scenarios: [], browserErrors: 0, screenshotErrors: [] };
let mocking = false, scenario = 'failed', resultReads = 0, failedPolls = 0, interruptedReads = 0;
page.on('pageerror', () => { report.browserErrors++; });
page.on('request', request => {
  if (!mocking && request.url().startsWith(base) && request.method() === 'POST') report.realUserServicePosts++;
});
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  localStorage.setItem('eagle-culling-auto-update', 'false');
  globalThis.selectionReads = 0;
  globalThis.eagle = { library: { path: 'synthetic.library', name: '界面验证' },
    folder: { getSelected: async () => [{ id: 'synthetic-folder', name: '示例文件夹' }] },
    item: { getSelected: async () => { globalThis.selectionReads++; return []; },
      count: async () => 400, countAll: async () => 8000,
      get: async () => Array.from({ length: 400 }, (_, index) => ({ id: `synthetic-${index}` })) } };
});
async function capture(name) {
  await page.screenshot({ path: path.join(qa, name) }).catch(error => {
    report.screenshotErrors.push({ name, reason: error.message.split('\n')[0] });
  });
}
function check(condition, message) { if (!condition) throw new Error(message); }
try {
  await page.goto('http://127.0.0.1:43127');
  await page.waitForFunction(() => document.querySelector('#health').textContent.includes('已连接'));
  report.scenarios.push({ name: 'real-user-service-GET-only', passed: true });
  await capture('real-user-home.png');
  mocking = true;
  const busy = { id: 'run-qa-busy', status: 'running', startedAt: new Date().toISOString(),
    progress: { stage: 'metrics', completed: 127, total: 3901, cached: 0 } };
  const failed = { id: 'run-qa-failed', status: 'failed', error: 'EPERM rename', progress: {} };
  await page.route(base + '/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers, body: '' });
    let body, status = 200;
    if (pathname === '/update/status') body = { hasUpdate: false, canUpdate: false, currentVersion: '1.0.0' };
    else if (pathname === '/health') body = { ok: true, service: 'eagle-culling' };
    else if (pathname === '/runs/status') body = scenario === 'busy' ? { active: busy, recent: [busy] }
      : { active: null, recent: [scenario === 'failed' ? failed : { ...failed, status: 'interrupted' }] };
    else if (pathname === '/runs' && request.method() === 'GET') {
      body = { runs: [scenario === 'busy' ? busy : scenario === 'failed' ? failed : { ...failed, status: 'interrupted' }],
        page: { nextCursor: null } };
    }
    else if (pathname === '/runs' && request.method() === 'POST') {
      const submitted = request.postDataJSON();
      check(submitted.scope?.type === 'folder' && submitted.itemIds?.length === 400, 'Primary folder submission changed');
      scenario = 'busy'; status = 409; body = { error: '已有分析任务运行中', run: busy };
    }
    else if (pathname === '/runs/run-qa-busy') {
      if (failedPolls > 0) { failedPolls--; return route.abort('failed'); }
      body = busy;
    }
    else if (pathname === '/runs/run-qa-failed') {
      if (scenario === 'interrupted') interruptedReads++;
      body = scenario === 'interrupted' ? { ...failed, status: 'interrupted' } : failed;
    }
    else { resultReads++; status = 500; body = { error: 'Unexpected results request' }; }
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#recentRuns').textContent.includes('无法保存文件'));
  check((await page.locator('#analyzeSelected').innerText()).includes('400'), 'Folder primary count missing');
  await page.locator('#analyzeSelected').click();
  await page.waitForFunction(() => document.querySelector('#health').textContent.includes('已有分析在进行'));
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('127 / 3901'));
  check(await page.locator('#analyzeSelected').isDisabled() && await page.locator('#analyzeAll').isDisabled(),
    'Busy service did not disable new analysis');
  check((await page.locator('#recentRuns').innerText()).includes('127/3901'), 'Recent busy card omitted progress');
  check(await page.locator('#runId').inputValue() === busy.id, 'Busy run was not exposed');
  report.scenarios.push({ name: 'busy-409-progress', passed: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('127 / 3901'));
  report.scenarios.push({ name: 'reopen-running', passed: true });
  failedPolls = 2; busy.progress.completed = 128;
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('128 / 3901'));
  report.scenarios.push({ name: 'two-network-failures-then-progress-recovers', passed: true });
  scenario = 'failed'; await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('无法保存文件'));
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#openRun').click();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('稍后重试'));
  check(resultReads === 0, 'Running/failed reopen attempted full results');
  report.scenarios.push({ name: 'reopen-failed-friendly-reason', passed: true });
  await capture('failed-home.png');
  scenario = 'interrupted'; await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('缓存仍可复用'));
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#openRun').click();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('分析已取消或中断'));
  await new Promise(resolve => setTimeout(resolve, 2000));
  check(interruptedReads === 1 && resultReads === 0, 'Interrupted open kept polling or read full results');
  report.scenarios.push({ name: 'reopen-interrupted', passed: true });
  check(report.realUserServicePosts === 0 && report.browserErrors === 0, 'Unexpected user write or browser error');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = error.message; process.exitCode = 1;
  await capture('failure.png');
} finally {
  await browser.close();
  await writeFile(path.join(qa, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
