// Real pixels, browser traces, reports and library context stay on Windows.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { inventory } from './windows-library.mjs';
import { hashFile } from '../src/core/metrics.js';
import { RunStore } from '../src/server/run-store.js';
if (process.platform !== 'win32') throw new Error('Windows-only real-photo QA');
const root = path.resolve('..'), qa = path.join(root, 'qa', 'plugin-e2e-isolated');
await mkdir(qa, { recursive: true });
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const base = 'http://127.0.0.1:43135';
async function request(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Validation HTTP ${response.status}`);
  return response.json();
}
const report = { status: 'running', steps: [], browserErrors: 0, contextAdapter: true };
async function step(name, fn) {
  console.log(JSON.stringify({ step: name, status: 'running' }));
  const result = await fn(); report.steps.push({ name, result });
  await writeFile(path.join(qa, 'acceptance.json'), JSON.stringify(report, null, 2));
  await appendFile(path.join(root, 'PROGRESS.md'),
    `${new Date().toISOString()} | UI ${name} | done | <validation-root>/qa/plugin-e2e-isolated | next UI step\n`);
  return result;
}
let browser, page;
try {
  const config = await read(path.join(root, 'w12-libraries.json'));
  const original = await read('data/windows-test/original-library.json');
  const library = config.libraries.find(value => value === original.path);
  if (!library) throw new Error('Active library outside allowlist');
  const { items, folders } = await inventory(library);
  const folder = folders.filter(f => !f.protected && f.count >= 200 && f.count <= 800)
    .sort((a, b) => Math.abs(a.count - 400) - Math.abs(b.count - 400))[0];
  if (!folder) throw new Error('No suitable safe folder');
  const selected = items.filter(item => item.folders?.includes(folder.id)).slice(0, 500);
  report.items = selected.length; report.folderHash = folder.hash;
  let before;
  try { before = await read(path.join(qa, 'integrity-before.json')); }
  catch {
    before = [];
    for (const item of selected) before.push([item.id, (await hashFile(item.filePath)).sha256]);
    await writeFile(path.join(qa, 'integrity-before.json'), JSON.stringify(before));
  }
  if (JSON.stringify(before.map(row => row[0])) !== JSON.stringify(selected.map(item => item.id))) {
    throw new Error('Checkpoint selection changed');
  }
  const { chromium } = await import(pathToFileURL(path.join(root, 'qa-tools/node_modules/playwright-core/index.mjs')));
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.EAGLE_QA_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(30000);
  page.on('pageerror', () => { report.browserErrors++; });
  await page.addInitScript(({ libraryPath, ids }) => {
    globalThis.eagle = { library: { path: libraryPath }, item: { getSelected: async () => ids.map(id => ({ id })) } };
  }, { libraryPath: library, ids: selected.map(item => item.id) });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await page.goto('http://127.0.0.1:43137');
  await page.locator('#base').fill(base);
  let run, checkpoint;
  try { checkpoint = await read(path.join(qa, 'run-id.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (checkpoint) {
    const saved = checkpoint;
    run = await request(`/runs/${saved.id}`);
    if (run.status !== 'completed') {
      const response = await fetch(base + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resumeRunId: saved.id }) });
      if (response.ok) run = await response.json();
      else if (response.status !== 409 || run.status !== 'running') throw new Error('Resume failed');
    }
  } else {
    // A durable checkpoint is required before polling; never create a second run on polling errors.
    const response = page.waitForResponse(r => r.url() === base + '/runs' && r.request().method() === 'POST');
    await page.locator('#analyzeSelected').click();
    const created = await response;
    if (!created.ok()) throw new Error('UI analysis creation failed');
    run = await created.json();
    await writeFile(path.join(qa, 'run-id.json'), JSON.stringify({ id: run.id }));
  }
  report.runId = run.id;
  const started = Date.now(), stages = {};
  let lastLog = 0;
  await step('analysis', async () => {
    while (run.status === 'running') {
      const stage = run.progress?.stage;
      stages[stage] = (stages[stage] || 0) + 1000;
      if (Date.now() - started > 3600000) throw new Error('Bounded analysis timeout; resume saved run');
      await new Promise(resolve => setTimeout(resolve, 1000));
      run = await request(`/runs/${run.id}`);
      if (Date.now() - lastLog >= 30000) {
        lastLog = Date.now();
        console.log(JSON.stringify({ stage, completed: run.progress?.completed, total: run.progress?.total }));
      }
    }
    if (run.status !== 'completed') throw new Error('Analysis failed; inspect local run');
    return { status: run.status, units: run.unitCount, groups: run.groupCount,
      elapsedSeconds: (Date.now() - started) / 1000, sampledStagesMilliseconds: stages };
  });
  const store = new RunStore(path.resolve('data/windows-test/runs'));
  const state = await store.get(run.id, { readOnly: true });
  await step('review', async () => {
    await page.locator('#runId').fill(run.id); await page.locator('#openRun').click();
    await page.locator('#review').waitFor({ state: 'visible' }); await page.locator('#filter').selectOption('all');
    await page.waitForFunction(() => [...document.querySelectorAll('#group .image-wrap img')]
      .some(i => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: path.join(qa, 'review.png') });
    return { loaded: true };
  });
  const reason = 'Windows 自动化审阅链路核对：保留/淘汰与理由（非用户真实偏好标签）';
  await step('decisions-and-reasons', async () => {
    const card = page.locator('#group .unit').first(), unitId = await card.getAttribute('data-unit-id');
    await card.locator('textarea').fill(reason);
    for (const action of ['selected', 'rejected']) {
      const response = page.waitForResponse(r => r.url().endsWith('/decisions') && r.request().method() === 'POST');
      await page.locator('#group .unit').first().locator(`[data-action="${action}"]`).click();
      const saved = await response, payload = await saved.json();
      if (!saved.ok() || payload.learningWarning || !payload.decisions.some(d => d.unitId === unitId && d.reason === reason)) {
        throw new Error('Decision or learning snapshot persistence failed');
      }
    }
    await page.reload(); await page.locator('#base').fill(base); await page.locator('#runId').fill(run.id);
    await page.locator('#openRun').click(); await page.locator('#filter').selectOption('all');
    if (await page.locator('#group .unit').first().locator('textarea').inputValue() !== reason) {
      throw new Error('Reopened reason mismatch');
    }
    return { actions: ['selected', 'rejected'], reasonPreserved: true };
  });
  await step('learning', async () => {
    await page.locator('#learningPanel summary').click();
    const response = page.waitForResponse(r => r.url().endsWith('/learning/train') && r.request().method() === 'POST');
    await page.locator('#learningTrain').click(); const saved = await response;
    if (!saved.ok()) throw new Error('Learning panel failed');
    const payload = await saved.json();
    return { httpStatus: saved.status(), ready: payload.ready ?? payload.profile?.ready ?? null,
      note: 'Automation decisions only; few labels do not establish trained preference quality.' };
  });
  await step('native-1-to-1', async () => {
    // Review paging may hide a face group. Walk visible groups until the magnifier is available.
    const groups = page.locator('#groupList [data-group-index]');
    let found = false;
    for (let i = 0; i < await groups.count(); i++) {
      await groups.nth(i).click();
      if (await page.locator('#nativeMagnifier').isVisible()) { found = true; break; }
    }
    if (!found) throw new Error('No face group on review page');
    await page.locator('#nativeMagnifier').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.native-viewport img')]
      .some(i => i.complete && i.naturalWidth > 0));
    await page.locator('[data-native-region]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.native-viewport img')]
      .some(i => i.src.includes('region=eyes') && i.complete && i.naturalWidth > 0));
    const dimensions = await page.locator('.native-viewport img').evaluateAll(images => images.filter(i => i.naturalWidth)
      .map(i => ({ natural: [i.naturalWidth, i.naturalHeight], css: [i.width, i.height] })));
    if (!dimensions.length || dimensions.some(d => d.natural[0] !== d.css[0] || d.natural[1] !== d.css[1])) {
      throw new Error('Native magnifier dimensions mismatch');
    }
    await page.screenshot({ path: path.join(qa, 'native-eyes.png') });
    return { dimensions };
  });
  await step('reports', async () => {
    const popup = page.waitForEvent('popup'); await page.locator('#reportJson').click();
    const tab = await popup; await tab.waitForLoadState();
    if (!(await tab.locator('body').innerText()).includes('decisionReason')) throw new Error('JSON report popup failed');
    await tab.close();
    const download = page.waitForEvent('download'); await page.locator('#reportCsv').click();
    await (await download).saveAs(path.join(qa, 'browser-report.csv'));
    for (const [id, name] of [['reportJson', 'report.json'], ['reportCsv', 'report.csv']]) {
      const href = await page.locator(`#${id}`).getAttribute('href');
      const response = await fetch(new URL(href, base));
      if (!response.ok) throw new Error('Report download failed');
      const text = await response.text();
      if (name.endsWith('.json') && !JSON.parse(text).some(row => row.decisionReason === reason)) {
        throw new Error('Export missing reason');
      }
      await writeFile(path.join(qa, name), text);
    }
    return { json: true, csv: true, reasonExported: true };
  });
  await step('integrity', async () => {
    let mismatches = 0; const hashes = new Map(before);
    for (const item of selected) mismatches += Number(hashes.get(item.id) !== (await hashFile(item.filePath)).sha256);
    if (mismatches) throw new Error('Original SHA-256 changed');
    return { originalsChecked: selected.length, mismatches };
  });
  report.missingQuality = state.results.filter(row => row.metrics?.quality == null).length;
  if (report.browserErrors) throw new Error('Browser runtime errors');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.failedStep = report.steps.at(-1)?.name || 'setup';
  // Detailed stack stays on Windows; sanitized acceptance carries only a status.
  await writeFile(path.join(qa, 'error-local.txt'), error.stack);
  console.log(JSON.stringify({ status: 'fail', message: error.message })); process.exitCode = 1;
} finally {
  if (page && report.status !== 'pass') await page.screenshot({ path: path.join(qa, 'failure.png') }).catch(() => {});
  await page?.context().tracing.stop({ path: path.join(qa, 'trace.zip') }).catch(() => {});
  await browser?.close();
  report.restore = await request('/validation/restore', {}).catch(() => ({ restored: false }));
  report.proxy = await request('/validation/status').catch(() => null);
  if (!report.restore.restored || report.proxy?.otherWriteRequests || report.proxy?.denied) {
    report.status = 'fail'; process.exitCode = 1;
  }
  await writeFile(path.join(qa, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
