// Emergency recovery QA: GET-only against the user service; all simulated POSTs are intercepted.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
if (process.platform !== 'win32') throw new Error('Windows UI QA only');
const root = path.resolve('..'), qa = path.join(root, 'qa', 'recovery');
await mkdir(qa, { recursive: true });
const { chromium } = await import(pathToFileURL(path.join(root, 'qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
const page = await browser.newPage();
const base = 'http://127.0.0.1:43125';
const report = { status: 'running', realUserServicePosts: 0, scenarios: [], browserErrors: 0, screenshotErrors: [] };
let mocking = false, scenario = 'busy', resultReads = 0, failedPolls = 0, interruptedReads = 0;
page.on('pageerror', () => { report.browserErrors++; });
page.on('request', request => {
  if (!mocking && request.url().startsWith(base) && request.method() === 'POST') report.realUserServicePosts++;
});
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  globalThis.selectionReads = 0;
  globalThis.eagle = { library: { path: 'synthetic.library' }, item: { getSelected: async () => {
    globalThis.selectionReads++; throw new Error('Whole-library analysis must not read selected items');
  } } };
});
async function capture(name) {
  await page.screenshot({ path: path.join(qa, name) }).catch(error => {
    report.screenshotErrors.push({ name, reason: error.message.split('\n')[0] });
  });
}
function check(condition, message) { if (!condition) throw new Error(message); }
try {
  await page.goto('http://127.0.0.1:43127');
  await page.waitForFunction(() => document.querySelector('#health').textContent.includes('服务已连接'));
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
    if (pathname === '/health') body = { ok: true, service: 'eagle-culling' };
    else if (pathname === '/runs/status') body = scenario === 'busy' ? { active: busy, recent: [busy] }
      : { active: null, recent: [scenario === 'failed' ? failed : { ...failed, status: 'interrupted' }] };
    else if (pathname === '/runs' && request.method() === 'POST') { status = 409; body = { error: '已有分析任务运行中', run: busy }; }
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
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('127/3901'));
  await page.locator('#analyzeAll').click();
  await page.waitForFunction(() => document.querySelector('#health').textContent.includes('已有分析在进行'));
  check(await page.evaluate(() => globalThis.selectionReads) === 0, 'Whole-library click read selected items');
  check(await page.locator('#runId').inputValue() === busy.id, 'Busy run was not exposed');
  report.scenarios.push({ name: 'busy-409-progress', passed: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('127/3901'));
  report.scenarios.push({ name: 'reopen-running', passed: true });
  failedPolls = 2; busy.progress.completed = 128;
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('128/3901'));
  report.scenarios.push({ name: 'two-network-failures-then-progress-recovers', passed: true });
  scenario = 'failed'; await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('无法保存文件'));
  await page.locator('#openRun').click();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('稍后重试'));
  check(resultReads === 0, 'Running/failed reopen attempted full results');
  report.scenarios.push({ name: 'reopen-failed-friendly-reason', passed: true });
  await capture('failed-home.png');
  scenario = 'interrupted'; await page.reload();
  await page.waitForFunction(() => document.querySelector('#progressText').textContent.includes('缓存仍可复用'));
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
