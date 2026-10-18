import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, stat, copyFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setPriority, getPriority, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { localSetting } from '../src/core/local-config.js';
import { EagleApi } from '../src/core/eagle-api.js';
import { normalizeLibraryPath } from '../src/core/eagle-api.js';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { ResultsStore } from '../src/core/results-store.js';
import { POSE_CACHE_KEY } from '../src/core/pose.js';
import { SCORER_CACHE_KEY } from '../src/core/scorer.js';
import { createReadOnlyEagleProxy } from './eagle-readonly-proxy.mjs';
import { eyeRoiQa } from './eye-roi-qa.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
function redactReport(value) {
  let text = JSON.stringify(value, null, 2);
  for (const [base, label] of [[repo, '<repo>'], [localSetting('EAGLE_EXPECTED_LIBRARY'), '<library>'],
    [localSetting('EAGLE_LIBRARY_PATH'), '<library>'], [homedir(), '<home>']])
    if (base) text = text.replaceAll(base, label);
  return text;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function command(args, env, file, executable = process.execPath) {
  const child = spawn('nice', ['-n', '15', executable, ...args], { cwd: repo,
    env: { ...process.env, ...env, NODE_OPTIONS: '--max-old-space-size=2048', EAGLE_SHARP_CONCURRENCY: '1',
      OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 600000); timer.unref();
  const log = createWriteStream(file);
  child.stdout.on('data', b => log.write(b)); child.stderr.on('data', b => log.write(b));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  await new Promise((resolve, reject) => { log.once('error', reject); log.end(resolve); });
  return { args, code, log: file };
}
export async function mainRealEagle() {
  const out = '/tmp/w10-real-eagle'; await mkdir(out, { recursive: true });
  const root = await mkdtemp(path.join(out, 'execution-'));
  if (process.argv.includes('--verify-only')) {
    const env = { EAGLE_PYTHON: localSetting('EAGLE_PYTHON'), EAGLE_BENCH_CACHE_ONLY: '1', EAGLE_SLOW_TESTS: '1',
      EAGLE_FIXTURE_LIBRARY: '' };
    const manifestHash = createHash('sha256').update(await readFile('test/fixtures/bench-syn-manifest.json')).digest('hex');
    let baseline;
    for (const name of (await readdir('data/cache/bench/reports')).sort().reverse()) {
      const file = path.join('data/cache/bench/reports', name, 'report.json');
      const report = await json(file);
      if (report.manifestSha256 === manifestHash) { baseline = file; break; }
    }
    if (!baseline) throw new Error('No matching baseline');
    const commands = [];
    for (const [name, args] of [
      ['node-tests', ['--test', '--test-concurrency=1']],
      ['bench', ['scripts/bench.mjs', '--compare', baseline]],
      ['public', ['scripts/check-public-release.mjs']],
    ]) {
      console.log(`START ${name}`);
      const result = await command(args, env, path.join(root, `${name}.log`)); commands.push(result);
      if (name === 'bench' && result.code === 0) {
        const reportDir = (await readFile(result.log, 'utf8')).split('\n').find(line =>
          line.startsWith('data/cache/bench/reports/'));
        const measured = reportDir ? await json(path.join(reportDir, 'report.json')) : null;
        result.comparison = measured?.comparison;
        result.noRegression = Boolean(measured?.comparison && measured.comparison.syntheticAccuracyDelta >= 0 &&
          measured.comparison.severeGateDelta >= 0 && measured.comparison.sourceFalseRejectDelta <= 0);
        if (!result.noRegression) result.code = 1;
      }
      console.log(`DONE ${name}: ${result.code}`);
    }
    const python = await command(['-m', 'unittest', 'discover', '-s', 'python_worker', '-p', 'test_*.py'], env,
      path.join(root, 'python-tests.log'), env.EAGLE_PYTHON); commands.push(python);
    await writeFile(path.join(out, 'validation.json'), JSON.stringify({ root, baseline, priority: getPriority(), commands }, null, 2));
    if (commands.some(c => c.code)) process.exitCode = 1;
    console.log(JSON.stringify({ root, baseline, commands }, null, 2)); return;
  }
  const report = { status: '未完成', root, steps: [], errors: [], commands: [] };
  let proxy, service, browser, activePage;
  const step = async (name, fn) => {
    console.log(`START ${name}`); const start = performance.now();
    try { const evidence = await fn(); report.steps.push({ name, status: 'pass', elapsedMs: performance.now()-start, evidence });
      console.log(`DONE ${name}`); return evidence;
    } catch (error) { report.steps.push({ name, status: 'fail', elapsedMs: performance.now()-start, error: error.message }); throw error; }
  };
  try {
    if (getPriority() < 15) setPriority(0, 15);
    report.priority = getPriority(); sharp.concurrency(1);
    const expected = localSetting('EAGLE_EXPECTED_LIBRARY');
    if (!expected || expected.includes('未删减')) throw new Error('Safe expected library required');
    proxy = createReadOnlyEagleProxy(process.env.W10_EAGLE_URL || 'http://127.0.0.1:41595');
    const proxyPort = await listen(proxy.server);
    const api = new EagleApi({ baseUrl: `http://127.0.0.1:${proxyPort}/api/v2`, expectedLibraryPath: expected });
    await step('assert active library', async () => {
      const library = await api.assertLibrary();
      if (normalizeLibraryPath(library.path) !== normalizeLibraryPath(expected)) throw new Error('Library mismatch');
      return { matched: true, version: api.apiVersion };
    });
    await step('doctor', async () => {
      const result = await command(['src/cli.js', 'doctor'], { EAGLE_API_PORT: String(proxyPort) }, path.join(root, 'doctor.log'));
      report.commands.push(result); const checks = JSON.parse(await readFile(result.log, 'utf8'));
      if (result.code || !checks.ok) throw new Error('Doctor failed'); return checks;
    });
    const folders = await api.get('folder/list');
    const find = rows => rows.flatMap(f => [f, ...find(f.children || [])]);
    const folder = find(folders).find(f => f.name === (process.env.W10_FOLDER || '20260718 汕头'));
    if (!folder || folder.name.includes('未删减')) throw new Error('Safe folder unavailable');
    const live = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.get('item/list', { folders: folder.id, limit: 500, offset });
      live.push(...page); if (page.length < 500) break;
    }
    const sourceFile = process.env.W10_RUN_SOURCE || path.resolve(repo,
      '../../EagleCullingPipeline/data/runs/run-1791589678002/results.json');
    const old = await json(sourceFile);
    if (normalizeLibraryPath(old.run.libraryPath) !== normalizeLibraryPath(expected)) throw new Error('Cache library mismatch');
    const liveMap = new Map(live.map(i => [i.id, i]));
    const units = old.units.filter(u => u.itemIds.every(id => liveMap.has(id)));
    const unitIds = new Set(units.map(u => u.id)), itemIds = new Set(units.flatMap(u => u.itemIds));
    const items = old.items.filter(i => itemIds.has(i.id));
    const results = old.results.filter(r => unitIds.has(r.unitId));
    if (!results.length || results.length !== units.length) throw new Error('Incomplete folder cache');
    // Match live API membership AND original metadata; never silently use another folder's cache.
    for (const item of items) {
      const file = item.filePath || item.path;
      if (!file || file.includes('未删减') || !path.resolve(file).startsWith(path.resolve(expected) + path.sep))
        throw new Error('Unsafe source');
      const info = await stat(file);
      if ((item.size && item.size !== info.size) || (item.mtimeMs && Math.abs(item.mtimeMs-info.mtimeMs)>1))
        throw new Error('Cached original metadata changed');
    }
    const hashes = async () => Object.fromEntries(await (async () => {
      const rows = [];
      for (const i of items) rows.push([i.id, createHash('sha256').update(await readFile(i.filePath || i.path)).digest('hex')]);
      return rows;
    })());
    const originalHashes = await step('original SHA-256 before', hashes);
    const data = { run: { ...old.run, id: `run-w10-${Date.now()}`, status: 'completed', libraryPath: expected }, units, items, results };
    await step('analyze cache-only pipeline', async () => {
      const cacheRoot = path.join(root, 'data/cache');
      await mkdir(path.join(cacheRoot, 'previews'), { recursive: true });
      const poseCache = await json(process.env.W10_POSE_CACHE || '/tmp/w1-pose-qa/all-results.json');
      const poseMap = new Map(poseCache.results.map(r => [r.unitId, r]));
      const records = [], cached = new Map();
      for (const unit of units) {
        const primary = items.find(i => i.id === unit.primaryItemId);
        const oldResult = results.find(r => r.unitId === unit.id);
        const record = { ...primary, filePath: primary.filePath || primary.path, unitId: unit.id,
          itemIds: unit.itemIds, pairedItems: items.filter(i => unit.itemIds.includes(i.id) && i !== primary) };
        const key = createHash('sha256').update(`${record.filePath}|${record.size || 0}|${record.mtimeMs || 0}`).digest('hex');
        const preview = path.join(cacheRoot, 'previews', `${key}.jpg`);
        await copyFile(oldResult.previewPath, preview);
        const size = await sharp(preview).metadata();
        await writeFile(`${preview}.json`, JSON.stringify(oldResult.source || {
          width: record.width, height: record.height, proxyWidth: size.width, proxyHeight: size.height,
          reliable: false, kind: 'cached-proxy' }));
        const fingerprint = createHash('sha256').update(JSON.stringify([
          record.path || record.filePath, record.size || 0, record.mtimeMs || 0,
          record.itemIds || [], preview, 'analysis-v6-exposure-gates', POSE_CACHE_KEY, SCORER_CACHE_KEY,
        ])).digest('hex');
        // Explicit migration of verified old measured features; never label it a fresh model inference.
        cached.set(fingerprint, { ...structuredClone(oldResult), previewPath: preview });
        records.push(record);
      }
      const destination = new ResultsStore(cacheRoot);
      const forbidden = async () => { throw new Error('Cold model/metric inference forbidden in cache-only replay'); };
      const pipeline = new AnalysisPipeline({ concurrency: 1, cacheRoot, analyzer: forbidden,
        faceDetector: forbidden,
        poseDetector: async targets => targets.map(t => {
          const previous = poseMap.get(t.id);
          const source = old.results.find(r => r.unitId === t.id);
          return previous?.previewPath === source?.previewPath ? { id: t.id, available: true,
            persons: previous.signals.persons, source: previous.signals.source,
            provider: 'cached-pose', imageMeasurements: previous.signals.imageMeasurements } :
            { id: t.id, available: false, error: { message: 'Cached pose unavailable; cold inference disabled' } };
        }), store: { get: async key => cached.get(key), put: (key, value) => destination.put(key, value) } });
      const analyzed = await pipeline.run(records, { id: data.run.id, nativeFocus: false });
      // QA below uses the original cache coordinates/provenance for a controlled before/after comparison.
      data.groups = analyzed.groups; data.results = analyzed.results;
      data.run.itemCount = items.length; data.run.unitCount = units.length; data.run.groupCount = data.groups.length;
      return { liveItems: live.length, cachedItems: items.length, units: units.length, groups: data.groups.length,
        progress: analyzed.progress, coldModels: 0, warnings: analyzed.warnings,
        mode: 'AnalysisPipeline.run with migrated measured-feature cache; native focus limited to separate 80-photo QA' };
    });
    const qa = await step('80 native eye ROI QA', () => eyeRoiQa({ ...data, results }));
    for (const r of data.results) if (qa.completedFaces.has(r.unitId)) r.faces = qa.completedFaces.get(r.unitId);
    for (const r of data.results) if (qa.completedFocus.has(r.unitId)) r.focus = qa.completedFocus.get(r.unitId);
    report.eyeQa = qa.summary;
    const runStore = new RunStore(path.join(root, 'data/runs')); await runStore.save(data.run, data);
    service = createAnalysisServer({ runStore, api,
      pipeline: { run() { throw new Error('Cold models forbidden during read-only QA'); } } });
    const router = service.server.listeners('request')[0]; service.server.removeAllListeners('request');
    service.server.on('request', async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/' || /^\/[a-z-]+\.(js|css|html|png)$/.test(pathname)) {
        try { const name = pathname === '/' ? 'index.html' : pathname.slice(1);
          const mime = { js: 'text/javascript', css: 'text/css', html: 'text/html', png: 'image/png' }[name.split('.').at(-1)];
          res.writeHead(200, { 'content-type': mime });
          res.end(await readFile(path.join(repo, 'src/plugin', name))); }
        catch { res.writeHead(404); res.end(); }
      } else await router(req, res);
    });
    const port = await step('serve isolated run', () => listen(service.server));
    const base = `http://127.0.0.1:${port}`, prefix = `/runs/${data.run.id}`;
    const { chromium } = await import(pathToFileURL(process.env.W8_PLAYWRIGHT || '/tmp/pw/node_modules/playwright/index.mjs'));
    browser = await step('launch browser', () => chromium.launch({ headless: true,
      ...(process.env.W8_BROWSER ? { executablePath: process.env.W8_BROWSER } : {}) }));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); activePage = page;
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await step('review thumbnails', async () => {
      await page.goto(base); await page.locator('#base').fill(base); await page.locator('#runId').fill(data.run.id);
      await page.locator('#openRun').click(); await page.locator('#review').waitFor({ state: 'visible' });
      await page.locator('#filter').selectOption('all');
      await page.waitForFunction(() => [...document.querySelectorAll('#group .image-wrap img')]
        .some(i => i.complete && i.naturalWidth > 0));
      await page.screenshot({ path: path.join(root, 'review.png') }); return { loaded: true };
    });
    const reason = '</textarea><script>123</script> 手势更自然 & 保留';
    await step('free text keep/reject and input focus', async () => {
      const card = page.locator('#group .unit').first();
      const unitId = await card.getAttribute('data-unit-id');
      await card.locator('textarea').fill(reason);
      let posts = 0; const listener = req => { if (req.method() === 'POST' && req.url().endsWith('/decisions')) posts++; };
      page.on('request', listener); await card.locator('textarea').press('3'); await page.waitForTimeout(300);
      page.off('request', listener); if (posts) throw new Error('Text input triggered shortcut');
      await card.locator('textarea').fill(reason);
      for (const action of ['selected', 'rejected']) {
        const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/decisions'));
        await page.locator('#group .unit').first().locator(`[data-action="${action}"]`).click();
        const response = await saved; const payload = await response.json();
        if (!response.ok() || payload.learningWarning || payload.decisions.find(d => d.unitId === unitId)?.reason !== reason)
          throw new Error('Reason/event persistence failed');
      }
      if (await page.locator('#group textarea script').count()) throw new Error('Reason escaped textarea');
      const events = (await readFile(path.join(root, 'data/learning/events/v1/events.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(JSON.parse);
      const recorded = events.filter(e => e.decisions?.some(d => d.unitId === unitId && d.reason === reason));
      if (recorded.length < 2) throw new Error('Free reason absent from persisted event snapshots');
      const decisions = await json(path.join(runStore.dir(data.run.id), 'decisions.json'));
      if (decisions.find(d => d.unitId === unitId)?.reason !== reason) throw new Error('Free reason absent from decisions file');
      await page.reload(); await page.locator('#base').fill(base); await page.locator('#runId').fill(data.run.id);
      await page.locator('#openRun').click(); await page.locator('#filter').selectOption('all');
      if (await page.locator('#group .unit').first().locator('textarea').inputValue() !== reason)
        throw new Error('Free reason lost on reopen');
      return { unitId, decisions: 2, reasonPreserved: true, shortcutsSuppressed: true };
    });
    await step('learning panel train', async () => {
      await page.locator('#learningPanel summary').click();
      const saved = page.waitForResponse(r => r.url().endsWith('/learning/train') && r.request().method() === 'POST');
      await page.locator('#learningTrain').click(); const response = await saved;
      if (!response.ok()) throw new Error('Learning train failed');
      return { status: response.status(), body: await response.json(), note: 'Few decisions; ready is not required or fabricated' };
    });
    await step('native face and eye magnifier', async () => {
      const target = data.groups.find(g => g.unitIds.some(id =>
        data.results.find(r => r.unitId === id)?.faces?.some(f => f.eyeBoxes?.length)));
      if (!target) throw new Error('No explicit eye ROI in run');
      await page.locator('#groupList [data-group-index]').nth(data.groups.indexOf(target)).click();
      await page.locator('#nativeMagnifier').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.native-viewport img')].some(i => i.complete && i.naturalWidth > 0));
      await page.locator('[data-native-region]').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.native-viewport img')]
        .some(i => i.src.includes('region=eyes') && i.complete && i.naturalWidth > 0));
      const dimensions = await page.locator('.native-viewport img').evaluateAll(images => images.filter(i => i.naturalWidth).map(i =>
        ({ natural: [i.naturalWidth, i.naturalHeight], css: [i.width, i.height] })));
      if (!dimensions.length || dimensions.some(d => d.natural[0] !== d.css[0] || d.natural[1] !== d.css[1]))
        throw new Error('Not native 1:1 CSS pixels');
      await page.screenshot({ path: path.join(root, 'native-eyes.png') }); return dimensions;
    });
    await step('export reports through UI links', async () => {
      const outputs = [];
      const popup = page.waitForEvent('popup');
      await page.locator('#reportJson').click();
      const reportPage = await popup; await reportPage.waitForLoadState();
      if (!(await reportPage.locator('body').innerText()).includes('decisionReason')) throw new Error('JSON report popup failed');
      await reportPage.close();
      const download = page.waitForEvent('download');
      await page.locator('#reportCsv').click();
      await (await download).saveAs(path.join(root, 'browser-report.csv'));
      for (const [id, name] of [['reportJson', 'report.json'], ['reportCsv', 'report.csv']]) {
        const href = await page.locator(`#${id}`).getAttribute('href');
        const response = await fetch(new URL(href, base));
        if (!response.ok) throw new Error('Report failed');
        const body = await response.text();
        if (name.endsWith('.json') && !JSON.parse(body).some(r => r.decisionReason === reason))
          throw new Error('Reason missing from export');
        await writeFile(path.join(root, name), body); outputs.push({ name, bytes: Buffer.byteLength(body) });
      }
      return outputs;
    });
    await step('original SHA-256 unchanged', async () => {
      const after = await hashes(); if (JSON.stringify(after) !== JSON.stringify(originalHashes)) throw new Error('Original changed');
      return { files: items.length, unchanged: true };
    });
    await writeFile(path.join(root, 'original-hashes.json'), JSON.stringify(originalHashes));
    if (errors.length) throw new Error(errors.join('; '));
    report.status = 'pass';
  } catch (error) { report.errors.push(error.stack); process.exitCode = 1; }
  finally {
    if (activePage && report.status !== 'pass') {
      await activePage.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
      await writeFile(path.join(root, 'failure.html'), await activePage.content().catch(() => '')).catch(() => {});
    }
    await activePage?.context().tracing.stop({ path: path.join(root, 'trace.zip') }).catch(() => {});
    await browser?.close(); await close(service?.server); await close(proxy?.server);
    report.requests = proxy?.requests || []; report.requestCounts = proxy?.summary() || {};
    report.writeAttempts = report.requests.filter(r => !r.allowed).length;
    if (report.writeAttempts) { report.status = 'fail'; process.exitCode = 1; }
    report.memory = { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS };
    if (report.memory.maxRssKiB > 3 * 1024 * 1024) { report.status = 'fail'; process.exitCode = 1; }
    await writeFile(path.join(root, 'acceptance.json'), redactReport(report));
    await writeFile(path.join(out, 'latest.json'), redactReport(report));
    console.log(JSON.stringify({ status: report.status, root, requests: report.requestCounts, errors: report.errors }, null, 2));
  }
}
