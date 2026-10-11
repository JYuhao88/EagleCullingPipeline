#!/usr/bin/env node
// Fixture setup may write run data; every simulated review/learning action uses the UI.
// No model inference, no Eagle connection other than the local read-only stub.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setPriority, getPriority } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, copyFile, access, rm, rename } from 'node:fs/promises';
import { createAnalysisServer } from '../src/server.js';
import { RunStore } from '../src/server/run-store.js';
import { EagleApi } from '../src/core/eagle-api.js';
import { rankGroup, suggestDecision } from '../src/core/ranking.js';
import { createEventReader } from './simulation-event-reader.mjs';
import { calibrateDrift } from './simulate-drift-calibration.mjs';
import { strongFixture } from './simulate-culling-strong.mjs';
import { buildCandidateSet } from '../src/core/candidates.js';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function utility(result, style) {
  const m = result.metrics || {}, raw = m.raw || {};
  const faces = result.faces || [];
  const people = result.signals?.persons || result.signals?.people || [];
  const areaOf = box => box ? Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]) : 0;
  const box = people.find(p => p.isMain)?.box || people[0]?.box;
  const area = box ? areaOf(box) : Math.max(0, ...faces.map(face => areaOf(face.box)));
  const direction = style === 'dark-tight' ? -1 : 1;
  return direction * 4 * (raw.meanLuma ?? m.meanLuma ?? 127.5) / 255
    - direction * 3 * (m.cropTightness ?? area) + 0.2 * (m.quality ?? 0)
    + 0.15 * (m.sharpness ?? 0) - 6 * (m.eyesClosed ?? 0);
}
function safeCache(file) {
  const resolved = path.resolve(file);
  if (!resolved.includes(`${path.sep}data${path.sep}cache${path.sep}`) || resolved.includes('未删减'))
    throw new Error(`Fixture preview must come from cache: ${file}`);
  return resolved;
}
async function listen(server, start = 43200) {
  for (let port = start; port < start + 100; port++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free port >=43200');
}
async function close(server) {
  if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function fixtures(root) {
  const id = 'run-1791589678002';
  const local = path.join(repo, 'data/runs', id);
  await mkdir(local, { recursive: true });
  // Only the historical run fixture is copied into this worktree. Never mutate its source.
  for (const name of ['run.json', 'results.json']) {
    try { await access(path.join(local, name)); }
    catch {
      const source = path.resolve(repo, '../../EagleCullingPipeline/data/runs', id, name);
      await copyFile(source, path.join(local, name));
    }
  }
  const old = await readJSON(path.join(local, 'results.json'));
  const data = structuredClone(old);
  data.run = { ...data.run, id: 'run-w8-browser', status: 'completed' };
  const unitMap = new Map(data.units.map(u => [u.id, u]));
  const itemMap = new Map(data.items.map(i => [i.id, i]));
  for (const result of data.results) {
    const source = safeCache(result.previewPath);
    const hash = digest(await readFile(source));
    const destination = path.join(root, 'photos', `${hash}.jpg`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    result.previewPath = destination; result.contentHash = hash; result.contentHashKind = 'proxy';
    // Original bytes are never opened by the simulator, including RAW companions.
    for (const itemId of unitMap.get(result.unitId)?.itemIds || []) {
      const item = itemMap.get(itemId);
      if (item) { item.path = destination; item.filePath = destination; item.thumbnailPath = destination; }
    }
  }
  const manifest = await readJSON(path.join(repo, 'test/fixtures/bench-syn-manifest.json'));
  let cached;
  for (const name of (await readdir(path.join(repo, 'data/cache/bench/reports'))).sort().reverse()) {
    try {
      const report = await readJSON(path.join(repo, 'data/cache/bench/reports', name, 'report.json'));
      const rows = new Map();
      for (const image of manifest.images) rows.set(image.id, await readJSON(path.join(repo,
        'data/cache/bench/analysis', `${digest(`${image.sha256}:${report.analysisSignature}`)}.json`)));
      cached = { rows, signature: report.analysisSignature }; break;
    } catch { /* Cached input only: no cold inference fallback. */ }
  }
  if (!cached) throw new Error('No complete T-syn cache; cold inference forbidden');
  for (const source of manifest.sources) {
    const images = manifest.images.filter(i => i.id === source.id ||
      manifest.pairs.some(p => p.sourceId === source.id && p.degradedId === i.id));
    const results = [];
    for (const image of images) {
      const file = safeCache(path.join(repo, 'data/cache/bench/syn', image.path));
      if (digest(await readFile(file)) !== image.sha256) throw new Error(`T-syn checksum mismatch ${image.id}`);
      const dest = path.join(root, 'photos', `${image.sha256}.jpg`); await copyFile(file, dest);
      const uid = `unit:tsyn:${image.id}`, iid = `tsyn:${image.id}`;
      data.items.push({ id: iid, name: image.id, ext: 'jpg', path: dest, filePath: dest, tags: [] });
      data.units.push({ id: uid, primaryItemId: iid, itemIds: [iid], formats: ['jpg'], contractVersion: 1 });
      const result = { ...cached.rows.get(image.id), unitId: uid, previewPath: dest,
        contentHash: image.sha256, contentHashKind: 'proxy' };
      results.push(result); data.results.push(result);
    }
    const ranking = rankGroup(results), map = new Map(results.map(r => [r.unitId, r]));
    data.groups.push({ id: `group:tsyn:${source.id}`, contractVersion: 1,
      unitIds: results.map(r => r.unitId), ranking,
      suggested: Object.fromEntries(ranking.map(r => [r.unitId, suggestDecision(r, map.get(r.unitId), results.length)])),
      candidateSet: buildCandidateSet(results) });
  }
  return { data, provenance: { historicalRun: id, cachedSignature: cached.signature,
    syntheticSources: manifest.sources.length, syntheticImages: manifest.images.length,
    photos: 'Local copies of cached proxies; no original deletion or cold models' } };
}
const CHECKS = ['default-baseline', 'candidate-toggle', 'event-actions-exposures', 'tie-reason-category',
  'undo', 'multi-day-clock', 'reopen-restores', 'two-tabs', 'training-curve', 'gate-block',
  'gate-allow', 'l0-hard-gates', 'profile-isolation', 'snapshot-rollback', 'ranking-rollback',
  'deletion-tombstones', 'feature-only-retrain', 'drift-after-switch', 'ui-performance', 'no-eagle-writes'];
export async function main() {
  const out = path.resolve(process.env.W8_QA_OUT || '/tmp/w8-simulate-qa');
  if (!out.startsWith('/tmp/')) throw new Error('W8_QA_OUT must be under /tmp');
  await mkdir(out, { recursive: true });
  // A blocked rerun must not leave screenshots or samples from an older successful execution.
  for (const name of ['initial.png', 'final.png', 'strong-final.png', 'failure.png', 'events.jsonl', 'assertions.json', 'index.html',
    'learning-curve.json', 'performance.json', 'node-tests.log'])
    await rm(path.join(out, name), { force: true });
  const root = await mkdtemp(path.join(out, 'execution-'));
  const report = { startedAt: new Date().toISOString(), status: '未完成', root,
    assertions: CHECKS.map(name => ({ name, status: '未完成' })), actions: [], curves: [], requests: [],
    driftObservations: [], errors: [], steps: [], browserRequests: [] };
  try { if (getPriority() < 10) setPriority(0, 10); }
  catch (error) { report.priorityWarning = error.message; }
  report.priority = getPriority();
  const check = (name, ok, evidence) => {
    Object.assign(report.assertions.find(a => a.name === name), { status: ok ? 'pass' : 'fail', evidence });
  };
  let stub, service, browser, activePage;
  async function step(label, operation, page = activePage) {
    const entry = { id: report.steps.length + 1, label, startedAt: new Date().toISOString() };
    report.steps.push(entry);
    console.log(`[step ${entry.id}] START ${label}`);
    const start = performance.now();
    try {
      const value = await operation();
      entry.status = 'pass'; entry.durationMs = performance.now() - start;
      console.log(`[step ${entry.id}] DONE ${label} (${entry.durationMs.toFixed(1)} ms)`);
      return value;
    } catch (error) {
      entry.status = 'fail'; entry.durationMs = performance.now() - start; entry.error = error.message;
      if (page && !page.isClosed()) {
        entry.screenshot = path.join(root, `failure-step-${entry.id}.png`);
        await page.screenshot({ path: entry.screenshot, fullPage: true }).catch(() => {});
        await writeFile(path.join(root, `failure-step-${entry.id}.html`), await page.content()).catch(() => {});
        entry.ui = await page.evaluate(() => ({ activeElement: document.activeElement?.outerHTML.slice(0, 180),
          focus: document.querySelector('#group .unit.focus')?.dataset.unitId,
          title: document.querySelector('#reviewTitle')?.textContent,
          learning: document.querySelector('#learningStatus')?.textContent,
          writeback: document.querySelector('#writeback')?.textContent,
          reasonsOpen: !document.querySelector('#rejectReasons')?.hidden })).catch(() => null);
      }
      console.log(`[step ${entry.id}] FAIL ${label}: ${error.message}`);
      console.log(JSON.stringify(entry.ui));
      throw error;
    }
  }
  let logicalTime = Date.UTC(2026, 0, 1), liveItems = [];
  try {
    const policy = await readJSON(process.env.W8_POLICY || path.join(repo, 'scripts/simulate-culling-policy.json'));
    report.policy = policy;
    const { data, provenance } = await step('prepare cached fixtures', () => fixtures(root));
    report.provenance = provenance;
    liveItems = [...data.items];
    const runStore = new RunStore(path.join(root, 'data/runs'));
    await runStore.save(data.run, data); // fixture ingestion, before any simulated review
    stub = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      report.requests.push({ method: req.method, path: url.pathname, query: url.search });
      const allowed = req.method === 'GET' && ['/api/library/info', '/api/item/list'].includes(url.pathname);
      res.setHeader('content-type', 'application/json');
      if (!allowed) {
        res.statusCode = 405;
        res.end(JSON.stringify({ status: 'error', message: 'Forbidden Eagle write/unknown read' }));
        return;
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      const payload = url.pathname.endsWith('library/info') ? { path: data.run.libraryPath } :
        liveItems.slice(offset, offset + limit);
      res.end(JSON.stringify({ status: 'success', data: payload }));
    });
    report.stubPort = await listen(stub);
    service = createAnalysisServer({ runStore, clock: () => new Date(logicalTime),
      pipeline: { analyze() { throw new Error('Cold models forbidden in simulation'); } },
      api: new EagleApi({ apiVersion: 1, baseUrl: `http://127.0.0.1:${report.stubPort}/api` }) });
    // Serve the unmodified real plugin alongside the real HTTP router.
    const router = service.server.listeners('request')[0]; service.server.removeAllListeners('request');
    service.server.on('request', async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/' || /^\/[a-z-]+\.(?:js|css|html|png)$/.test(pathname)) {
        try {
          const name = pathname === '/' ? 'index.html' : pathname.slice(1);
          const bytes = await readFile(path.join(repo, 'src/plugin', name));
          const mime = { js: 'text/javascript', css: 'text/css', html: 'text/html', png: 'image/png' }[name.split('.').at(-1)];
          res.writeHead(200, { 'content-type': mime }); res.end(bytes);
        } catch { res.writeHead(404); res.end(); }
      } else await router(req, res);
    });
    report.servicePort = await listen(service.server, report.stubPort + 1);
    const base = `http://127.0.0.1:${report.servicePort}`;
    let activeRunId = data.run.id, prefix = `/runs/${activeRunId}`;
    const get = async suffix => {
      const response = await fetch(base + prefix + suffix);
      if (!response.ok) throw new Error(`GET ${suffix}: ${response.status}`);
      return response.json();
    };
    const before = await get('/results');
    check('default-baseline', JSON.stringify(before.groups.map(g => [g.ranking.map(r => [r.unitId, r.rank, r.score]), g.suggested])) ===
      JSON.stringify(data.groups.map(g => [g.ranking.map(r => [r.unitId, r.rank, r.score]), g.suggested])),
    'Actual HTTP results vs fixture L0, before browser actions');
    const { chromium } = await import(pathToFileURL(process.env.W8_PLAYWRIGHT || '/tmp/pw/node_modules/playwright/index.mjs'));
    browser = await step('launch headless browser', () => chromium.launch({ headless: true,
      ...(process.env.W8_BROWSER ? { executablePath: process.env.W8_BROWSER } : {}) }));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const open = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      activePage = page;
      page.on('request', req => {
        if (req.method() !== 'POST') return;
        const row = { type: 'request', method: req.method(), path: new URL(req.url()).pathname,
          body: req.postDataJSON(), time: new Date().toISOString() };
        report.browserRequests.push(row);
        console.log(`[request] ${row.method} ${row.path} ${JSON.stringify(row.body).slice(0, 180)}`);
      });
      page.on('response', response => {
        if (response.request().method() !== 'POST' && response.status() < 400) return;
        const row = { type: 'response', status: response.status(), path: new URL(response.url()).pathname };
        report.browserRequests.push(row);
        console.log(`[response] ${row.status} ${row.path}`);
      });
      page.on('pageerror', error => report.errors.push({ type: 'browser', message: error.message }));
      page.on('dialog', dialog => dialog.accept());
      return step('open review page', async () => {
      await page.goto(base); await page.locator('#runId').fill(activeRunId);
      const exposed = page.waitForResponse(r => r.request().method() === 'POST' &&
        r.url().endsWith(prefix + '/learning/exposure'));
      exposed.catch(() => {});
      await page.locator('#openRun').click(); await page.locator('#review').waitFor({ state: 'visible' });
      await page.locator('#learningPanel summary').click();
      await page.locator('#learningStatus').filter({ hasText: 'Profile' }).waitFor();
      await exposed;
      return page;
      }, page);
    };
    let page = await open();
    const postAction = async (p, suffix, action, label = suffix, matches = () => true) => {
      activePage = p;
      return step(label, async () => {
      const previousEvents = suffix === '/decisions' ? new Set((await events()).map(e => e.id)) : null;
      const start = performance.now();
      const inputFocus = await p.evaluate(() => {
        const cards = [...document.querySelectorAll('#group .unit')];
        return { tag: document.activeElement?.tagName, id: document.activeElement?.id,
          unit: document.querySelector('#group .unit.focus')?.dataset.unitId,
          order: cards.map(c => c.dataset.unitId), viewport: cards.filter(card => {
            const rect = card.getBoundingClientRect();
            return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
          }).map(c => c.dataset.unitId), aiVisible: !document.querySelector('#group .rank')?.hidden };
      });
      if (suffix === '/decisions') await p.evaluate(() => {
        window.__w8TimingCleanup?.();
        const timing = { start: null, duration: null };
        const start = () => { if (timing.start === null) timing.start = performance.now(); };
        const done = () => { if (timing.start !== null && timing.duration === null) timing.duration = performance.now() - timing.start; };
        window.addEventListener('keydown', start, true); window.addEventListener('pointerdown', start, true);
        window.addEventListener('culling:decision-rendered', done);
        window.__w8Timing = timing;
        window.__w8TimingCleanup = () => {
          window.removeEventListener('keydown', start, true); window.removeEventListener('pointerdown', start, true);
          window.removeEventListener('culling:decision-rendered', done);
        };
      });
      console.log(`[action] ${label}; focus=${JSON.stringify({ tag: inputFocus.tag, id: inputFocus.id, unit: inputFocus.unit })}`);
      const pending = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(prefix + suffix) &&
        matches(r.request().postDataJSON()),
      { timeout: ['/learning/train', '/feedback'].includes(suffix) ? 60000 : 15000 });
      pending.catch(() => {});
      await action(); const response = await pending; const payload = await response.json();
      if (suffix === '/decisions' && response.ok()) {
        await p.waitForFunction(saved => [...document.querySelectorAll('#group .unit')].every(card => {
          const human = saved.find(d => d.unitId === card.dataset.unitId && d.source === 'human');
          return human ? Boolean(card.querySelector(`.human.action-${human.action}`)) : !card.querySelector('.human');
        }), payload.decisions);
      }
      if (response.ok() && ['/learning/config', '/learning/select', '/learning/train', '/learning/rollback'].includes(suffix)) {
        await p.waitForFunction(expected => {
          const text = document.querySelector('#learningStatus')?.textContent || '';
          const options = [...document.querySelectorAll('#learningSnapshots option')].map(o => o.value);
          return text.includes(`Profile：${expected.profileId}；L1 ${expected.enabled ? '已启用' : '关闭'}`) &&
            document.querySelector('#learningEnabled')?.checked === expected.enabled &&
            (!expected.version || options.includes(expected.version)) &&
            (!expected.drift || text.includes('偏好可能变化'));
        }, { profileId: payload.profileId, enabled: Boolean(payload.config?.enabled),
          version: payload.version, drift: payload.drift?.detected });
      }
      if (suffix === '/learning/apply' && response.ok()) {
        await p.locator('#learningStatus').filter({ hasText: `已按验证快照更新 ${payload.changedGroups} 个未审组` }).waitFor();
      }
      const durationMs = performance.now() - start;
      const nativeUiMs = suffix === '/decisions' ? await p.evaluate(() => {
        window.__w8TimingCleanup?.(); return window.__w8Timing?.duration ?? null;
      }) : null;
      console.log(`[timing] ${label}: automation=${durationMs.toFixed(1)} ms; native=${nativeUiMs?.toFixed(1) ?? "n/a"} ms; `
        + `server=${response.headers()['server-timing'] || "n/a"}`);
      const eventIds = previousEvents ? (await events()).filter(e => !previousEvents.has(e.id) &&
        ['decision', 'undo'].includes(e.type)).map(e => e.id) : undefined;
      report.actions.push({ label, endpoint: suffix, day: Math.floor((logicalTime - Date.UTC(2026, 0, 1)) / 86400000),
        status: response.status(), durationMs, nativeUiMs,
        scenario: activeRunId,
        serverTiming: response.headers()['server-timing'],
        request: response.request().postDataJSON(), eventIds,
        inputExposure: /^key:[123]$/.test(label) ? inputFocus : undefined,
        payload: suffix === '/decisions' ? { decisionsCount: payload.decisions?.length,
          learningWarning: payload.learningWarning } : payload });
      if (payload.learningWarning) report.errors.push({ type: 'learningWarning', message: payload.learningWarning });
      return { status: response.status(), payload };
      }, p);
    };
    const click = (suffix, id) => postAction(page, suffix, () => page.locator(id).click(), `click ${id}`);
    const decision = key => postAction(page, '/decisions', () => page.keyboard.press(key), `key:${key}`);
    const gotoGroup = async (p, index) => {
      activePage = p;
      return step(`navigate to group ${index + 1}`, async () => {
      const expected = groups[index];
      if (await p.locator(`.group-list-item.active[data-group-index="${index}"]`).count()) return;
      const exposed = p.waitForResponse(r => r.request().method() === 'POST' &&
        r.url().endsWith(prefix + '/learning/exposure') && r.request().postDataJSON().groupId === expected.id);
      exposed.catch(() => {});
      await p.locator(`[data-group-index="${index}"]`).click();
      await p.locator(`#group .unit[data-unit-id="${expected.ranking[0].unitId}"]`).waitFor();
      // A historical exposure from another tab/session cannot satisfy this wait.
      await exposed;
      }, p);
    };
    const events = createEventReader(path.join(root, 'data/learning/events/v1/events.jsonl'));
    let groups = before.groups.filter(g => g.unitIds.length > 1), results = new Map(data.results.map(r => [r.unitId, r]));
    const random = seededRandom(policy.seed);
    await page.screenshot({ path: path.join(out, 'initial.png'), fullPage: true });
    const initialCards = await page.locator('#group .unit').evaluateAll(cards => cards.map(card => ({
      unitId: card.dataset.unitId,
      suggested: card.querySelector('strong[class^="action-"]')?.className.replace('action-', '')
    })));
    const baselineOK = report.assertions.find(a => a.name === 'default-baseline').status === 'pass';
    check('default-baseline', baselineOK && JSON.stringify(initialCards) === JSON.stringify(groups[0].ranking.map(row => ({
      unitId: row.unitId, suggested: groups[0].suggested[row.unitId] || 'candidate'
    }))) && await page.locator('#candidateToggle').getAttribute('aria-pressed') === 'false',
    { httpExactBaseline: baselineOK, initialCards });
    await step('enable candidate set', () => page.locator('#candidateToggle').click());
    check('candidate-toggle', await page.locator('#candidateToggle').getAttribute('aria-pressed') === 'true');
    await step('restore default candidate set off', () => page.locator('#candidateToggle').click());
    await page.locator('#learningEnabled').check(); await click('/learning/config', '#learningSave');
    const blocked = await click('/learning/apply', '#learningApply'); check('gate-block', blocked.status === 409, blocked.payload);
    await page.locator('#learningEnabled').uncheck(); await click('/learning/config', '#learningSave');
    let firstSnapshot, firstWeights, appliedRanking, appliedVersion, appliedWeights;
    const tryApply = async status => {
      if (!status.report.ready || appliedRanking) return;
      await page.locator('#learningEnabled').check(); await click('/learning/config', '#learningSave');
      const applied = await click('/learning/apply', '#learningApply');
      check('gate-allow', applied.status === 200, applied.payload);
      appliedRanking = (await get('/results')).groups;
      appliedVersion = status.version;
      appliedWeights = status.head.weights;
      const changed = appliedRanking.filter(g => g.preferenceSnapshot === appliedVersion);
      check('l0-hard-gates', changed.length > 0 && changed.every(g => {
        const tiers = g.ranking.map(r => (r.reasons?.includes('硬伤门槛：排在通过者之后') ? 2 : 0)
          + (r.reasons?.includes('同组睁眼帧优先') ? -1 : 0));
        return tiers.every((tier, n) => !n || tiers[n - 1] <= tier);
      }), { appliedGroups: changed.length });
    };
    for (let i = 0; i < groups.length - 4; i++) {
      logicalTime = Date.UTC(2026, 0, 1) + Math.floor(i / policy.groupsPerDay) * 86400000 + (i % policy.groupsPerDay) * 60000;
      if (i && i % policy.groupsPerDay === 0) { await page.close(); page = await open(); }
      await gotoGroup(page, i);
      const style = policy.styles[Number(i >= policy.switchAfterGroups)], group = groups[i];
      const candidates = group.ranking.filter(r => !r.reasons?.includes('硬伤门槛：排在通过者之后'));
      let preferred = [...(candidates.length ? candidates : group.ranking)].sort((a, b) =>
        utility(results.get(b.unitId), style) - utility(results.get(a.unitId), style))[0];
      const displayed = await page.locator('#group .unit').evaluateAll(cards => cards.map(c => c.dataset.unitId));
      const draw = random();
      if (draw < policy.noiseRate) preferred = group.ranking[Math.floor(random() * group.ranking.length)];
      else if (draw < policy.noiseRate + policy.anchorRate && await page.locator('#group .recommend').count())
        preferred = { unitId: displayed[0] };
      const index = displayed.indexOf(preferred.unitId);
      await step(`group ${i + 1}: focus ${preferred.unitId} (${style})`,
        () => page.locator(`#unitStrip [data-unit-index="${index}"]`).click());
      // Buttons hold keyboard focus but inputs do not: the next key uses real shortcuts.
      if (i && i % policy.tieEvery === 0) await click('/decisions', '#tieGroup');
      else if (i && i % policy.rejectEvery === 0) {
        await click('/decisions', '#rejectGroup');
        const reason = page.locator('#rejectReasonChips [data-reason]').first();
        if (await reason.isVisible()) await postAction(page, '/feedback', () => reason.click(), 'reason-chip',
          body => body.replaces && body.unitId === group.unitIds.at(-1));
        await page.keyboard.press('Enter');
      } else {
        await decision('3'); await page.keyboard.press('Enter');
        await decision('2'); await decision('1');
        await click('/decisions', '#acceptGroup');
      }
      if (i && i % policy.undoEvery === 0) await decision('u');
      if ((i + 1) % policy.trainEvery === 0) {
        if (i >= policy.switchAfterGroups) {
          const oldHead = await get('/learning');
          report.driftObservations.push({ groups: i + 1, version: oldHead.version, drift: oldHead.drift });
        }
        if (policy.freezeAfterSwitch && i >= policy.switchAfterGroups) {
          if (await page.locator('#rejectReasons').isVisible()) await page.keyboard.press('Enter');
          await postAction(page, '/learning/exposure', () => page.keyboard.press('Enter'), 'next-group:Enter',
            body => body.groupId === groups[i + 1].id);
          continue;
        }
        const trained = await click('/learning/train', '#learningTrain');
        const status = trained.payload;
        report.curves.push({ reviewedGroups: i + 1,
          actions: report.actions.filter(a => a.endpoint === '/decisions').length, report: status.report, drift: status.drift });
        if (!firstSnapshot) { firstSnapshot = status.version; firstWeights = status.head.weights; }
        await tryApply(status);
      }
      if (await page.locator('#rejectReasons').isVisible()) await page.keyboard.press('Enter');
      await postAction(page, '/learning/exposure', () => page.keyboard.press('Enter'), 'next-group:Enter',
        body => body.groupId === groups[i + 1].id);
    }
    // Two real tabs concurrently save separate groups in the same service process.
    const other = await open();
    await gotoGroup(page, groups.length - 4); await gotoGroup(other, groups.length - 3);
    const ids = [await page.locator('#group .unit.focus').getAttribute('data-unit-id'),
      await other.locator('#group .unit.focus').getAttribute('data-unit-id')];
    await Promise.all([postAction(page, '/decisions', () => page.keyboard.press('1')),
      postAction(other, '/decisions', () => other.keyboard.press('1'))]);
    check('two-tabs', (await get('/decisions')).decisions.filter(d => ids.includes(d.unitId) && d.source === 'human').length === 2);
    await other.close();
    // Actual bulk acceptance, including the two untouched groups, then real undo.
    await click('/decisions', '#acceptUnreviewed'); await decision('u');
    check('two-tabs', (await get('/decisions')).decisions.filter(d => ids.includes(d.unitId) &&
      d.source === 'human' && d.action === 'selected').length === 2, 'Both tab choices survive subsequent bulk acceptance and undo');
    const saved = (await get('/decisions')).decisions.filter(d => d.source === 'human');
    await page.close(); page = await open();
    const restored = (await get('/decisions')).decisions.filter(d => d.source === 'human');
    check('reopen-restores', JSON.stringify(saved) === JSON.stringify(restored) && await page.locator('#group .human').count() > 0);
    const driftStatus = await click('/learning/select', '#learningLoad');
    report.driftObservations.push({ groups: groups.length - 4, version: driftStatus.payload.version,
      drift: driftStatus.payload.drift });
    const warning = await page.locator('#learningStatus').textContent();
    check('drift-after-switch', driftStatus.payload.drift.detected && warning.includes('偏好可能变化'),
      { observations: report.driftObservations, text: warning });
    // Create a later real snapshot, then roll back the earlier actually applied snapshot.
    const lateTrain = await click('/learning/train', '#learningTrain');
    report.curves.push({ phase: 'post-switch', reviewedGroups: groups.length - 2,
      actions: report.actions.filter(a => a.endpoint === '/decisions').length,
      report: lateTrain.payload.report, drift: lateTrain.payload.drift });
    if (!lateTrain.payload.report.ready) {
      await page.locator('#learningEnabled').check(); await click('/learning/config', '#learningSave');
      const denied = await click('/learning/apply', '#learningApply');
      check('gate-block', blocked.status === 409 && denied.status === 409,
        { emptyProfile: blocked.payload, shantouTrained: lateTrain.payload.report, denied: denied.payload });
      await page.locator('#learningEnabled').uncheck(); await click('/learning/config', '#learningSave');
    }
    const hadApplied = Boolean(appliedRanking);
    await tryApply(lateTrain.payload);
    if (!hadApplied && appliedRanking) await click('/learning/train', '#learningTrain');
    await page.locator('#learningProfile').fill('alternate'); await click('/learning/select', '#learningLoad');
    const alternate = await get('/learning?profileId=alternate');
    await page.close(); page = await open();
    check('profile-isolation', !alternate.head && !alternate.config.enabled &&
      await page.locator('#learningProfile').inputValue() === 'alternate');
    await page.locator('#learningProfile').fill('default'); await click('/learning/select', '#learningLoad');
    const rollbackVersion = appliedVersion || firstSnapshot, rollbackWeights = appliedWeights || firstWeights;
    if (rollbackVersion) {
      await page.locator('#learningSnapshots').selectOption(rollbackVersion);
      const rollback = await click('/learning/rollback', '#learningRollback');
      check('snapshot-rollback', rollback.payload.version === rollbackVersion &&
        JSON.stringify(rollback.payload.head.weights) === JSON.stringify(rollbackWeights));
      // Reapply only if genuine heldout validation permits it; never manufacture readiness.
      if (rollback.payload.report.ready && rollback.payload.config.enabled && appliedVersion === rollbackVersion) {
        await click('/learning/apply', '#learningApply');
        const humans = new Set((await get('/decisions')).decisions.filter(d => d.source === 'human').map(d => d.unitId));
        const current = (await get('/results')).groups.filter(g => g.preferenceSnapshot && !g.unitIds.some(id => humans.has(id)));
        check('ranking-rollback', current.length > 0 && current.every(g => {
          const previous = appliedRanking.find(old => old.id === g.id);
          return JSON.stringify([g.ranking, g.suggested]) === JSON.stringify([previous?.ranking, previous?.suggested]);
        }), { snapshot: rollbackVersion, comparedUnreviewedGroups: current.length });
      }
    }
    // Stub inventory deletion only: not even local photo files are deleted.
    const deleted = groups[0].unitIds.slice(-2).flatMap(uid => data.units.find(u => u.id === uid).itemIds);
    liveItems = liveItems.filter(i => !deleted.includes(i.id));
    const scan = await click('/learning/scan-deletions', '#learningScan');
    const rows = await events();
    check('deletion-tombstones', scan.payload.tombstones > 0 &&
      rows.some(e => e.type === 'tombstone' && e.itemIds.some(id => deleted.includes(id))), scan.payload);
    const train1 = await click('/learning/train', '#learningTrain');
    report.curves.push({ phase: 'post-deletion', reviewedGroups: groups.length - 2,
      actions: report.actions.filter(a => a.endpoint === '/decisions').length,
      report: train1.payload.report, drift: train1.payload.drift });
    // Make ONLY the simulator's proxy copies unavailable during retraining.
    // Nothing in Eagle or the shared cache is renamed or deleted.
    let train2;
    await rename(path.join(root, 'photos'), path.join(root, 'photos-offline'));
    try { train2 = await click('/learning/train', '#learningTrain'); }
    finally { await rename(path.join(root, 'photos-offline'), path.join(root, 'photos')); }
    check('feature-only-retrain', JSON.stringify(train1.payload.head.weights) === JSON.stringify(train2.payload.head.weights) &&
      train1.payload.trainingData.digest === train2.payload.trainingData.digest,
      'HTTP train results identical with all simulator proxy paths unavailable; actual Eagle originals untouched');
    await writeFile(path.join(out, 'events.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const decisionActions = report.actions.filter(a => a.endpoint === '/decisions');
    const unloggedActions = decisionActions.filter(a => !a.eventIds?.length).map(a => a.label);
    const mismatchedViewports = decisionActions.filter(a => a.inputExposure && !a.eventIds.some(id => {
      const event = rows.find(e => e.id === id && e.decisions.some(d => d.unitId === a.inputExposure.unit));
      const exposure = rows.find(e => e.id === event?.exposureEventId);
      return exposure && JSON.stringify([exposure.display.map(d => d.unitId),
        exposure.display.filter(d => d.inViewport).map(d => d.unitId), exposure.aiVisible]) ===
        JSON.stringify([a.inputExposure.order, a.inputExposure.viewport, a.inputExposure.aiVisible]);
    })).map(a => ({ action: a.label, unit: a.inputExposure.unit }));
    check('event-actions-exposures', !unloggedActions.length && !mismatchedViewports.length &&
      ['explicit', 'corrected', 'bulk'].every(s => rows.some(e => e.signal === s)) &&
      rows.filter(e => e.type === 'decision' && e.signal !== 'bulk').every(e => e.exposureKnown &&
        rows.some(x => x.id === e.exposureEventId && x.display?.length && typeof x.aiVisible === 'boolean')),
      { decisionActions: decisionActions.length, unloggedActions, mismatchedViewports,
        linkedEvents: decisionActions.map(a => ({ action: a.label, eventIds: a.eventIds })) });
    check('tie-reason-category', rows.some(e => e.tie && e.reason && e.category === 'candidate') &&
      rows.some(e => e.category === 'group' && e.reason));
    check('undo', rows.some(e => e.type === 'undo' && e.targetEventId));
    check('multi-day-clock', new Set(rows.filter(e => e.type === 'decision').map(e => e.timestamp.slice(0, 10))).size > 1);
    check('training-curve', report.curves.length > 1 &&
      report.curves.some(c => c.report.learningCurve.some(p => p.sampleCount > 0)),
    report.curves.map(c => ({ actions: c.actions, reviewedGroups: c.reviewedGroups, reason: c.report.reason })));
    check('ui-performance', report.actions.every(a => Number.isFinite(a.durationMs)),
      report.actions.map(a => ({ label: a.label, ms: a.durationMs })));
    await page.screenshot({ path: path.join(out, 'final.png'), fullPage: true });
    report.shantou = { curves: structuredClone(report.curves),
      drift: driftStatus.payload.drift, positiveChecks: report.assertions.filter(a =>
        ['gate-allow', 'l0-hard-gates', 'ranking-rollback'].includes(a.name)).map(a => ({ ...a })) };
    // The independent scenario uses a separate run/profile but exactly the same
    // real UI, HTTP handlers and unchanged heldout application gate.
    if (policy.strong) {
      const fixture = await step('construct strong consistent workflow batch', () => strongFixture(root, data, policy.strong));
      await runStore.save(fixture.run, fixture);
      logicalTime = Date.UTC(2026, 0, 1);
      await page.close(); activeRunId = fixture.run.id; prefix = `/runs/${activeRunId}`;
      groups = fixture.groups; page = await open();
      await page.locator('#learningProfile').fill('strong'); await click('/learning/select', '#learningLoad');
      const cfg = policy.strong, stableObservations = [];
      let switchCheckpoint;
      const strongRandom = seededRandom(policy.seed + 1);
      const strongReview = async (start, end, style, era) => {
        for (let i = start; i < end; i++) {
          logicalTime = Date.UTC(2026, 0, 1) + era * (cfg.switchGapDays ?? 365) * 86400000
            + Math.floor(i / cfg.groupsPerDay) * 86400000 + i % cfg.groupsPerDay * 60000;
          if (i && i % cfg.groupsPerDay === 0) { await page.close(); page = await open(); }
          await gotoGroup(page, i);
          const rows = fixture.results.filter(r => groups[i].unitIds.includes(r.unitId));
          let preferred = [...rows].sort((a, b) => utility(b, style) - utility(a, style))[0];
          const draw = strongRandom();
          if (draw < cfg.noiseRate) preferred = rows[Math.floor(strongRandom() * rows.length)];
          else if (draw < cfg.noiseRate + cfg.anchorRate) {
            const first = await page.locator('#group .unit').first().getAttribute('data-unit-id');
            preferred = rows.find(r => r.unitId === first);
          }
          await page.locator(`#group .unit[data-unit-id="${preferred.unitId}"] h3`).click();
          await decision('1'); await click('/decisions', '#acceptGroup');
          if (style === 'bright-loose' && i + 1 === cfg.trainingGroups + cfg.stableGroups + 25) {
            const status = await click('/learning/select', '#learningLoad');
            switchCheckpoint = { drift: status.payload.drift, text: await page.locator('#learningStatus').textContent() };
          }
          if (style === 'dark-tight' && i >= cfg.trainingGroups && (i + 1) % 5 === 0) {
            const status = await click('/learning/select', '#learningLoad');
            stableObservations.push({ groups: i + 1, drift: status.payload.drift });
          }
        }
      };
      await strongReview(0, cfg.trainingGroups, 'dark-tight', 0);
      const trained = await click('/learning/train', '#learningTrain');
      report.curves.push({ scenario: 'strong', reviewedGroups: cfg.trainingGroups,
        actions: report.actions.filter(a => a.scenario === activeRunId && a.endpoint === '/decisions').length,
        report: trained.payload.report });
      await page.locator('#learningEnabled').check(); await click('/learning/config', '#learningSave');
      const l0 = (await get('/results')).groups;
      const applied = await click('/learning/apply', '#learningApply');
      const first = (await get('/results')).groups;
      const holdoutIds = new Set(groups.slice(-cfg.holdoutGroups).map(g => g.id));
      const changed = first.filter(g => holdoutIds.has(g.id));
      const ordering = g => JSON.stringify([g.ranking, g.suggested]);
      await gotoGroup(page, groups.length - cfg.holdoutGroups);
      const appliedDOM = await page.locator('#group .unit').evaluateAll(cards => cards.map(c => c.dataset.unitId));
      const expectedGuardOrder = changed[0]?.ranking.map(r => r.unitId);
      const appliedDOMMatches = JSON.stringify(appliedDOM) === JSON.stringify(expectedGuardOrder);
      check('gate-allow', appliedDOMMatches && trained.payload.report.ready
        && applied.status === 200 && applied.payload.changedGroups > 0 &&
        changed.every(g => g.ranking[0].unitId.endsWith('-dark')) &&
        changed.some(g => ordering(g) !== ordering(l0.find(x => x.id === g.id))),
        { scenario: 'strong', report: trained.payload.report, applied: applied.payload,
          holdoutChanged: changed.filter(g => ordering(g) !== ordering(l0.find(x => x.id === g.id))).length });
      const guardEvidence = changed.map(g => ({ id: g.id, ranking: g.ranking.map(r => ({ id: r.unitId, flags: r.flags,
        reasons: r.reasons })) }));
      check('l0-hard-gates', appliedDOMMatches && changed.length === cfg.holdoutGroups && changed.every(g => {
        const good = g.ranking.filter(r => /-(dark|bright|neutral)$/.test(r.unitId));
        const bad = g.ranking.filter(r => /-(closed|blurred)$/.test(r.unitId));
        return good.length === 3 && bad.length === 2 && bad.every(r =>
          r.reasons.includes('硬伤门槛：排在通过者之后') && r.rank > Math.max(...good.map(x => x.rank)))
          && bad.some(r => r.preferenceScore > good.find(x => x.unitId.endsWith('-bright')).preferenceScore);
      }), guardEvidence);
      const firstVersion = trained.payload.version;
      await strongReview(cfg.trainingGroups, cfg.trainingGroups + cfg.stableGroups, 'dark-tight', 0);
      await strongReview(cfg.trainingGroups + cfg.stableGroups,
        cfg.trainingGroups + cfg.stableGroups + cfg.switchedGroups, 'bright-loose', 1);
      const switched = await click('/learning/select', '#learningLoad');
      report.strong = { fixture: { groups: groups.length, ...cfg,
        provenance: 'T-syn cached template with constructed contrasts and unique JPEG proxy bytes; not an image-quality benchmark' },
        stableObservations, falseAlarms: stableObservations.filter(x => x.drift.detected).length,
        testedWindows: stableObservations.length, switched: switchCheckpoint, finalWindow: switched.payload.drift };
      report.driftCalibration = calibrateDrift();
      report.strong.falseAlarmRate = stableObservations.length ? report.strong.falseAlarms / stableObservations.length : null;
      check('drift-after-switch', driftStatus.payload.drift.detected && switchCheckpoint?.drift.detected &&
        switchCheckpoint.text.includes('偏好可能变化') && stableObservations.length > 0 && report.strong.falseAlarms === 0,
        { shantou: driftStatus.payload.drift, strong: report.strong });
      await page.locator('#learningHalfLife').fill(String(cfg.switchedHalfLifeDays ?? 3)); await click('/learning/config', '#learningSave');
      const reverse = await click('/learning/train', '#learningTrain');
      report.curves.push({ scenario: 'strong-switched', reviewedGroups: cfg.trainingGroups + cfg.stableGroups + cfg.switchedGroups,
        actions: report.actions.filter(a => a.scenario === activeRunId && a.endpoint === '/decisions').length,
        report: reverse.payload.report });
      const reverseApply = await click('/learning/apply', '#learningApply');
      const reverseGroups = (await get('/results')).groups.filter(g => holdoutIds.has(g.id));
      await page.locator('#learningSnapshots').selectOption(firstVersion);
      const rollback = await click('/learning/rollback', '#learningRollback');
      await click('/learning/apply', '#learningApply');
      const restored = (await get('/results')).groups.filter(g => holdoutIds.has(g.id));
      await gotoGroup(page, groups.length - cfg.holdoutGroups);
      const restoredDOM = await page.locator('#group .unit').evaluateAll(cards => cards.map(c => c.dataset.unitId));
      check('ranking-rollback', JSON.stringify(restoredDOM) === JSON.stringify(appliedDOM) && reverseApply.status === 200
        && reverseGroups.every(g => g.ranking[0].unitId.endsWith('-bright')) &&
        restored.length === changed.length && restored.every(g => ordering(g) === ordering(changed.find(x => x.id === g.id))),
        { version: firstVersion, reverseReport: reverse.payload.report, comparedGroups: restored.length,
          beforeDigest: digest(changed.map(ordering).join('')), afterDigest: digest(restored.map(ordering).join('')) });
      check('snapshot-rollback', rollback.payload.version === firstVersion &&
        JSON.stringify(rollback.payload.head.weights) === JSON.stringify(trained.payload.head.weights));
      await page.screenshot({ path: path.join(out, 'strong-final.png'), fullPage: true });
    }
    const finalEvents = await events();
    await writeFile(path.join(out, 'events.jsonl'), finalEvents.map(r => JSON.stringify(r)).join('\n') + '\n');
    const strongActions = report.actions.filter(a => a.scenario === 'run-w8-strong' && a.endpoint === '/decisions');
    const strongUnlogged = strongActions.filter(a => !a.eventIds?.length).map(a => a.label);
    const strongMismatch = strongActions.filter(a => a.inputExposure && !a.eventIds.some(id => {
      const event = finalEvents.find(e => e.id === id && e.decisions.some(d => d.unitId === a.inputExposure.unit));
      const exposure = finalEvents.find(e => e.id === event?.exposureEventId);
      return exposure && JSON.stringify([exposure.display.map(d => d.unitId),
        exposure.display.filter(d => d.inViewport).map(d => d.unitId), exposure.aiVisible]) ===
        JSON.stringify([a.inputExposure.order, a.inputExposure.viewport, a.inputExposure.aiVisible]);
    })).map(a => a.label);
    const originalEventsCheck = report.assertions.find(a => a.name === 'event-actions-exposures');
    check('event-actions-exposures', originalEventsCheck.status === 'pass' && !strongUnlogged.length && !strongMismatch.length,
      { ...originalEventsCheck.evidence, strongDecisionActions: strongActions.length, strongUnlogged, strongMismatch });
    const single = report.actions.filter(a => /^key:[123u]$/.test(a.label)).map(a => a.nativeUiMs).sort((a, b) => a - b);
    const bulk = report.actions.filter(a => ['/decisions', '/feedback'].includes(a.endpoint) && !/^key:/.test(a.label));
    const p95 = single[Math.ceil(single.length * 0.95) - 1];
    const scenarioP95 = [...new Set(report.actions.map(a => a.scenario))].map(scenario => {
      const times = report.actions.filter(a => a.scenario === scenario && /^key:[123u]$/.test(a.label))
        .map(a => a.nativeUiMs).sort((a, b) => a - b);
      return { scenario, count: times.length, p95Ms: times[Math.ceil(times.length * 0.95) - 1] };
    });
    check('ui-performance', single.every(Number.isFinite) && Number.isFinite(p95) && p95 < 300
      && scenarioP95.every(s => Number.isFinite(s.p95Ms) && s.p95Ms < 300)
      && bulk.length > 0 && bulk.every(a => a.durationMs < 2000),
      { singleCount: single.length, scenarioP95, p95Ms: p95, maximumMs: single.at(-1), bulkCount: bulk.length,
        bulkMaximumMs: Math.max(...bulk.map(a => a.durationMs)),
        slowActions: report.actions.filter(a => /^key:[123u]$/.test(a.label) ? a.nativeUiMs >= 300 :
          ['/decisions', '/feedback'].includes(a.endpoint) && a.durationMs >= 2000).map(a => ({ label: a.label, ms: a.durationMs,
            serverTiming: a.serverTiming })) });
    // These are failures of the exercised scenario's acceptance requirements,
    // not fabricated evidence for positive branches whose prerequisites never held.
    for (const name of ['gate-allow', 'l0-hard-gates', 'ranking-rollback']) {
      if (report.assertions.find(a => a.name === name).status !== '未完成') continue;
      check(name, false, { reason: 'No genuinely validated/applied snapshot for this positive-path check',
        reports: report.curves.map(c => ({ groups: c.reviewedGroups, ready: c.report.ready, reason: c.report.reason })) });
    }
  } catch (error) {
    report.errors.push({ type: 'execution', message: error.stack, step: report.steps.at(-1)?.label });
    if (activePage && !activePage.isClosed())
      await activePage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  }
  finally {
    if (browser) await browser.close();
    await close(service?.server); await close(stub);
    check('no-eagle-writes', report.requests.every(r => r.method === 'GET' &&
      ['/api/library/info', '/api/item/list'].includes(r.path)),
    { count: report.requests.length, types: [...new Set(report.requests.map(r => `${r.method} ${r.path}`))] });
    report.finishedAt = new Date().toISOString();
    report.counts = Object.fromEntries(['pass', 'fail', '未完成'].map(s => [s, report.assertions.filter(a => a.status === s).length]));
    if (report.policy?.regression && !report.counts['未完成']) {
      console.log('[regression] START serial Node suite (browser and services closed)');
      const args = ['--test', '--test-concurrency=1',
        '--test-skip-pattern=fixture face detection recall|fixture grouping reaches'];
      const regression = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8',
        timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
      const log = path.join(out, 'node-tests.log');
      await writeFile(log, (regression.stdout || '') + (regression.stderr || ''));
      report.regression = { command: [process.execPath, ...args], exitCode: regression.status,
        signal: regression.signal, error: regression.error?.message, log, inheritedPriority: getPriority() };
      if (regression.status !== 0) report.errors.push({ type: 'regression', message: `Node suite failed; see ${log}` });
      console.log(`[regression] DONE exit=${regression.status}; log=${log}`);
    }
    report.status = report.counts.fail ? 'fail' : report.counts['未完成'] || report.errors.length ? '未完成' : 'pass';
    await writeFile(path.join(out, 'learning-curve.json'), JSON.stringify(report.curves, null, 2));
    const stats = times => {
      if (!times.length || !times.every(Number.isFinite)) return { count: times.length, reason: 'incomplete-measurement' };
      const sorted = [...times].sort((a, b) => a - b);
      return { count: sorted.length, medianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maximumMs: sorted.at(-1) };
    };
    report.performance = {
      timingDefinition: { ui: 'captured input event -> persisted response and confirmed DOM render',
        automation: 'Playwright evaluate/action/HTTP/DOM wait; includes automation overhead',
        bulk: 'full automation duration; reason revision waits for final feedback response' },
      byScenario: [...new Set(report.actions.map(a => a.scenario))].map(scenario => {
        const actions = report.actions.filter(a => a.scenario === scenario);
        const keys = actions.filter(a => /^key:[123u]$/.test(a.label));
        return { scenario, allDecisionsAutomation: stats(actions.filter(a => a.endpoint === '/decisions').map(a => a.durationMs)),
          singleNative: stats(keys.map(a => a.nativeUiMs)),
          singleAutomation: stats(keys.map(a => a.durationMs)),
          bulk: stats(actions.filter(a => ['/decisions', '/feedback'].includes(a.endpoint) && !/^key:/.test(a.label))
            .map(a => a.durationMs)), training: stats(actions.filter(a => a.endpoint === '/learning/train').map(a => a.durationMs)) };
      }),
      decisions: report.actions.filter(a => a.endpoint === '/decisions')
        .map(a => ({ action: a.label, day: a.day, uiResponseMs: a.nativeUiMs, automationResponseMs: a.durationMs, scenario: a.scenario })),
      training: report.actions.filter(a => a.endpoint === '/learning/train')
        .map(a => ({ action: a.label, day: a.day, trainingMs: a.durationMs })),
      serverStages: report.actions.filter(a => a.endpoint === '/decisions').map(a => ({ action: a.label, serverTiming: a.serverTiming }))
    };
    await writeFile(path.join(out, 'performance.json'), JSON.stringify(report.performance, null, 2));
    await writeFile(path.join(out, 'assertions.json'), JSON.stringify(report, null, 2));
    const escaped = JSON.stringify(report, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    const table = `<table><tr><th>断言</th><th>实际结果</th></tr>${report.assertions.map(a =>
      `<tr><td>${escape(a.name)}</td><td>${escape(a.status)}</td></tr>`).join('')}</table>`;
    const curve = `<table><tr><th>场景</th><th>审阅组</th><th>允许应用</th><th>留出提升</th></tr>${report.curves.map(c =>
      `<tr><td>${escape(c.scenario || 'shantou')}</td><td>${c.reviewedGroups}</td><td>${c.report.ready}</td>`
      + `<td>${escape(JSON.stringify(c.report.improvement))}</td></tr>`).join('')}</table>`;
    const html = `<!doctype html><meta charset="utf-8"><title>W8 browser simulation</title>`
      + `<style>body{font:16px system-ui;max-width:1100px;margin:30px auto}td,th{padding:8px;border:1px solid #aaa}`
      + `table{border-collapse:collapse}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${report.status}</h1>`
      + `<p>模拟用户仅验证流程，不能证明真实偏好效果。未执行检查明确标未完成。</p>${table}`
      + `<h2>学习曲线检查点</h2>${curve}<h2>性能（逐次记录见 performance.json）</h2>`
      + `<pre>${escape(JSON.stringify(report.performance.byScenario, null, 2))}</pre>`
      + `<p><a href="initial.png">初始截图</a> · <a href="strong-final.png">合成场景截图</a> · `
      + `<a href="assertions.json">完整断言 JSON</a> · <a href="events.jsonl">实际事件日志</a></p>`
      + `<details><summary>全部原始证据</summary><pre>${escaped}</pre></details>`;
    await writeFile(path.join(out, 'index.html'), html);
    console.log(JSON.stringify({ status: report.status, counts: report.counts, output: out,
      errors: report.errors.map(e => e.message.split('\n')[0]) }, null, 2));
    if (report.status !== 'pass') process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
