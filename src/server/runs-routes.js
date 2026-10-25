import { resultAiTags } from './item-analysis.js';
import { parsePerformanceMode, configuredPerformanceMode } from '../core/performance-mode.js';
import { RunProgress, measuredWeights } from '../core/run-progress.js';
import { Checkpoints } from "../core/checkpoints.js";
import { DecisionsStore } from "../core/decisions-store.js";
import { scopeKey, inheritDecisions, supersedeOlderRuns } from "../core/task-continuity.js";
import { pageOptions } from "./pagination.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { listEagleImages } from "../core/metrics.js";
import { buildCaptureUnits } from "../core/capture-units.js";
import { groupConfidence, CONFIDENCE_MARGIN_THRESHOLD } from "../core/ranking.js";
import { CORS_HEADERS, json, parseBody } from "./http.js";
import { faceImage } from "./face-image.js";
import { focusCropImage, parseRegionBox, regionCropImage, prefetchRegionImage } from "./focus-image.js";
import { readMid } from '../core/native-mid.js';
import { withNativeImage } from '../core/native-image.js';
import { isRaw, isHeif } from '../core/image-formats.js';
import { snapDisplayEdge } from '../core/display.js';
import { readFocusPoints } from '../core/focus-points.js';
import { touchCache } from '../core/cache-budget.js';
export { snapDisplayEdge } from '../core/display.js';

function activeRun(active) {
  return active.run && (active.run.controller || ["queued", "running"].includes(active.run.status))
    ? active.run
    : null;
}

function runSummary(run) {
  const summary = { ...run };
  for (const key of ["controller", "results", "groups", "units", "items", "duplicateCandidates"]) delete summary[key];
  return summary;
}

function prefetchSummary(run) {
  return { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt || null,
    itemCount: run.itemCount || 0, cached: run.progress?.cached ?? null };
}

function runFromState(state) {
  return state?.run || state;
}

export function reviewGroups(state) {
  const byId = new Map((state?.results || []).map(result => [result.unitId || result.id, result]));
  return (state?.groups || []).map(group => {
    const confidence = group.preferenceSnapshot ? { confidence: "low", margin: null } : groupConfidence(group, byId);
    const close = confidence.margin !== null && confidence.margin < CONFIDENCE_MARGIN_THRESHOLD;
    const ranking = (group.ranking || []).map(entry => entry.rank === 1 && close ? {
      ...entry, reasons: [...new Set([...(entry.reasons || []), "与第二名很接近，建议人工确认"])]
    } : entry);
    return { ...group, ...confidence, ranking };
  });
}

function decodeUnitId(value) {
  try {
    const id = decodeURIComponent(value);
    return id && !/[\\/\u0000]/.test(id) && id !== "." && id !== ".." ? id : null;
  } catch {
    return null;
  }
}

const pendingDetails = new Map();
const pendingDisplays = new Map();
// A thumbnail fallback is retried once per service start (decoders may have been installed since), not per request.
// RAW images cached before the current preview probe are rebuilt once, so a camera JPEG found since replaces a generic decode.
const reprobedFallbacks = new Set();
const PREVIEW_PROBE = 3;
const retryFallback = (file, metadata, ext) => (isRaw(ext) && (metadata?.probe || 1) < PREVIEW_PROBE)
  || (metadata?.previewSource === 'eagle-thumbnail' && (isRaw(ext) || isHeif(ext)) && !reprobedFallbacks.has(file)
    && Boolean(reprobedFallbacks.add(file)));

async function detailImage(store, id, unitId, state) {
  const key = path.join(store.dir(id), "detail", `${encodeURIComponent(unitId)}.jpg`);
  if (!pendingDetails.has(key)) {
    const pending = createDetailImage(store, id, unitId, state).finally(() => pendingDetails.delete(key));
    pendingDetails.set(key, pending);
  }
  return pendingDetails.get(key);
}

async function createDetailImage(store, id, unitId, state) {
  const unit = state.units?.find(item => item.id === unitId);
  const result = state.results?.find(item => item.unitId === unitId);
  const item = state.items?.find(candidate => candidate.id === unit?.primaryItemId);
  const source = item?.filePath || item?.path || result?.sourcePath || result?.previewPath;
  if (!unit || !result || !source) return null;
  const file = path.join(store.dir(id), "detail", `${encodeURIComponent(unitId)}.jpg`);
  try {
    await access(file);
    const cached = JSON.parse(await readFile(`${file}.json`, 'utf8').catch(() => '{"previewSource":"eagle-thumbnail"}'));
    if (!retryFallback(file, cached, item?.ext)) return file;
  } catch {
    /* rebuild old or incomplete entries */
  }
  await mkdir(path.dirname(file), { recursive: true });
  let previewSource = 'sharp';
  for (const candidate of [...new Set([source, result.previewPath].filter(Boolean))]) {
      try {
        const ext = path.extname(candidate).toLowerCase();
        if (!isRaw(ext) && !isHeif(ext)) {
          await sharp(candidate, { failOn: "none" }).rotate().resize({
            width: 2048, height: 2048, fit: "inside", withoutEnlargement: true
          }).jpeg({ quality: 90 }).toFile(file);
        } else {
          const pairedItems = state.items?.filter(entry => entry.id !== item?.id && (unit.itemIds || []).includes(entry.id)) || [];
          const native = await withNativeImage({ ...item, filePath: candidate, ext: ext.slice(1) }, {
            pairedItems, purpose: 'display', minEdge: 2048 / Math.max(item.width || 0, item.height || 0, 2048),
          },
            async ({ image }) => image().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 90 }).toFile(file));
          if (!native?.available && native?.warnings) throw new Error(native.warnings.join('；'));
        }
        if (candidate === result.previewPath && (isRaw(item?.ext) || isHeif(item?.ext))) previewSource = 'eagle-thumbnail';
        await writeFile(`${file}.json`, JSON.stringify({ previewSource, probe: PREVIEW_PROBE }));
        return file;
      } catch {
        continue;
      }
  }
  return null;
}
function unitRecord(state, unitId) {
  const unit = state.units?.find(item => item.id === unitId);
  const items = state.items?.filter(item => (unit?.itemIds || [unit?.primaryItemId]).includes(item.id)) || [];
  const primary = items.find(item => item.id === unit?.primaryItemId) || items[0];
  return { unit, items, primary };
}

export async function displayImage(store, id, unitId, state, requestedEdge) {
  const { unit, items, primary } = unitRecord(state, unitId);
  if (!unit || !primary) return null;
  const result = state.results?.find(item => item.unitId === unitId);
  const source = primary.filePath || primary.path || result?.sourcePath || result?.previewPath;
  if (!source) return null;
  let sourceLongEdge = Number(result?.source?.width && result?.source?.height
    ? Math.max(result.source.width, result.source.height) : 0);
  if (!sourceLongEdge) sourceLongEdge = Math.max(Number(primary.width) || 0, Number(primary.height) || 0);
  const edge = snapDisplayEdge(requestedEdge, sourceLongEdge || Infinity);
  const file = path.join(store.dir(id), 'display', `${encodeURIComponent(unitId)}-${edge}.jpg`);
  const sidecar = `${file}.json`;
  try {
    const metadata = JSON.parse(await readFile(sidecar, 'utf8'));
    if (!retryFallback(file, metadata, primary.ext)) {
      await access(file); await touchCache(file); await touchCache(sidecar);
      return { path: file, edge: metadata.edge || edge, source: metadata.previewSource || 'display', warning: metadata.warning };
    }
  } catch { /* stale or missing */ }
  const pendingKey = `${file}|${source}`;
  if (!pendingDisplays.has(pendingKey)) {
    const pending = (async () => {
      await mkdir(path.dirname(file), { recursive: true });
      let displaySource = 'sharp', warning;
      // Native pipelines arrive upright already; sharp keeps only the last rotate(), so a second one would undo theirs.
      const write = async (pipeline, kind) => {
        const info = await pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(file);
        displaySource = kind; return { width: info.width, height: info.height };
      };
      let dimensions;
      const mid = await readMid(primary, { pairedItems: items.filter(item => item !== primary) });
      // A mid image decoded generically from a RAW would hide the camera's own JPEG colours, so the RAW is probed again.
      const genericRaw = ['decoded-raw', 'raw-wic'].includes(mid?.source?.kind);
      if (mid && !genericRaw && Math.max(mid.width, mid.height) >= edge) {
        dimensions = await write(sharp(mid.path), 'native-mid');
      } else {
        try {
          if (isRaw(primary.ext) || isHeif(primary.ext)) {
            const native = await withNativeImage(primary, {
              pairedItems: items.filter(item => item !== primary), purpose: 'display',
              minEdge: edge / Math.max(sourceLongEdge || 0, edge),
            },
              async ({ image, source: nativeSource }) => { dimensions = await write(image(), nativeSource.kind); return dimensions; });
            if (native?.available === false) throw new Error(native.warnings?.join('；') || 'native unavailable');
          } else {
            dimensions = await write(sharp(source, { failOn: 'none' }).rotate(), 'sharp');
          }
        } catch (error) {
          warning = error.message;
          if (!state.results?.find(item => item.unitId === unitId)?.previewPath) throw error;
          dimensions = await write(sharp(result.previewPath, { failOn: 'none' }).rotate(), 'eagle-thumbnail');
          warning = warning || '已降级到 Eagle 缩略图';
        }
      }
      const metadata = { edge: Math.max(dimensions.width, dimensions.height), previewSource: displaySource, warning, probe: PREVIEW_PROBE };
      await writeFile(sidecar, JSON.stringify(metadata));
      await touchCache(file); await touchCache(sidecar);
      return { path: file, edge: Math.max(dimensions.width, dimensions.height), source: displaySource, warning };
    })().finally(() => pendingDisplays.delete(pendingKey));
    pendingDisplays.set(pendingKey, pending);
  }
  return pendingDisplays.get(pendingKey);
}

async function persist(store, run, data) {
  await store.save(run, { ...data, run });
}

export function createRunsRouter({
  pipeline,
  store,
  active = { run: null },
  scanItems = listEagleImages,
  progressIntervalMs = 250,
  heartbeatMs = 1000,
  now = () => performance.now(),
  isUpdating = () => false,
  beforeRun = async () => {},
  onFinished = () => {},
  canPrefetch = () => true,
} = {}) {
  const prefetchControllers = new Set();
  const finishing = new WeakMap();
  async function startRun(body) {
    const reply = (status, payload) => [status, payload];
    if (isUpdating()) return reply(409, { error: "正在更新，请稍后开始分析" });
    if (body.rerunOf !== undefined) {
      if (typeof body.rerunOf !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(body.rerunOf)) return reply(400, { error: 'Invalid rerunOf' });
      const original = store.dir ? await new Checkpoints(store.dir(body.rerunOf)).get('request').catch(() => null) : null;
      if (!original) return reply(409, { error: '找不到原分析范围，请在 Eagle 重新选择照片后分析；已做的决定会自动带上' });
      body = { ...original, ...(body.performanceMode ? { performanceMode: body.performanceMode } : {}) };
    }
    const current = activeRun(active);
    // Background prefetch only warms caches; a user's analysis always takes over.
    if (current?.purpose === 'prefetch' && body.purpose !== 'prefetch') {
      current.controller?.abort(new Error('用户开始分析，空闲预处理已暂停'));
      await finishing.get(current)?.catch(() => {});
    }
    if (activeRun(active)) {
      return reply(409, { error: "已有分析任务运行中", run: runSummary(activeRun(active)) });
    }
    if (body.purpose === 'prefetch' && !canPrefetch()) return reply(409, { error: '有排队的分析，空闲预处理稍后再做' });
    try {
      if (body.purpose !== undefined && !['analysis', 'prefetch'].includes(body.purpose))
        throw new Error('Invalid purpose');
      if (body.purpose === 'prefetch' && (!Array.isArray(body.itemIds) || body.itemIds.length > 300))
        throw new Error('Prefetch requires at most 300 itemIds');
      if (Object.hasOwn(body, 'performanceMode') && !['normal', 'turbo'].includes(body.performanceMode))
        throw new Error('performanceMode must be normal or turbo');
    }
    catch (error) { return reply(400, { error: error.message }); }
    const resumeId = body.resumeRunId;
    if (resumeId && !/^[a-zA-Z0-9_-]+$/.test(resumeId)) return reply(400, { error: 'Invalid resumeRunId' });
    const previousRun = resumeId ? await store.getRun(resumeId) : null;
    if (resumeId && (!previousRun || previousRun.status === 'completed')) {
      return reply(409, { error: 'Run missing or already completed' });
    }
    const id = resumeId || `run-${randomUUID()}`;
    const checkpoint = store.dir ? new Checkpoints(store.dir(id)) : null;
    const request = resumeId ? await checkpoint?.get('request') : body;
    if (!request) return reply(409, { error: 'No resumable scan checkpoint' });
    let mode;
    try { mode = request.purpose === 'prefetch' ? 'normal'
      : parsePerformanceMode(request.performanceMode ?? configuredPerformanceMode()); }
    catch (error) { return reply(400, { error: error.message }); }
    if (!resumeId && checkpoint) await checkpoint.put('request', body);
    const history = store.list ? (await store.list({ limit: 20, cursor: 0 })).runs || [] : [];
    const tracker = new RunProgress({ now, weights: measuredWeights(history) || undefined });
    const run = {
      contractVersion: 1,
      id,
      status: "running",
      performanceMode: mode,
      purpose: request.purpose || 'analysis',
      startedAt: new Date().toISOString(),
      progress: tracker.update({ completed: 0, total: 0, cached: 0, stage: 'scanning' }),
      libraryPath: request.libraryPath || null,
      ...(request.scope && ['selection', 'folder', 'unfiled', 'library'].includes(request.scope.type) ? { scope: {
        type: request.scope.type, label: String(request.scope.label || '').slice(0, 200),
        ...(typeof request.scope.folderId === 'string' ? { folderId: request.scope.folderId.slice(0, 200) } : {}),
        key: scopeKey({ ...request.scope, folderId: request.scope.folderId?.slice?.(0, 200) }, request.itemIds),
      } } : {}),
      itemCount: 0,
      unitCount: 0,
      groupCount: 0,
    };
    const data = { units: [], items: [], results: [], groups: [] };
    const controller = new AbortController();
    run.controller = controller;
    if (isUpdating()) return reply(409, { error: "正在更新，请稍后开始分析" });
    for (const controller of prefetchControllers) controller.abort(new Error("analysis started"));
    // Reserve before awaiting cancellation of maintenance or initial persistence.
    if (activeRun(active)) return reply(409, { error: '已有分析任务运行中' });
    active.run = run;
    await beforeRun();
    if (store.saveProgress) await store.saveProgress(run);
    else await store.save(run, { run });
    let lastProgressAt = 0;
    let lastProgressStage;
    const progressWrites = new Set();
    const onProgress = progress => {
      run.progress = tracker.update(progress);
      const time = now();
      if (progress.stage !== lastProgressStage || time - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = time;
        lastProgressStage = progress.stage;
        const pending = (store.saveProgress ? store.saveProgress(run) : store.save(run, { run })).catch(error => {
          run.progressWarning = error.message;
        }).finally(() => progressWrites.delete(pending));
        progressWrites.add(pending);
      }
    };
    const heartbeat = setInterval(() => onProgress(tracker.last), heartbeatMs);
    heartbeat.unref?.();
    const execute = async () => {
      controller.signal.throwIfAborted();
      let scan = checkpoint ? await checkpoint.get('scanning') : null;
      if (!scan) {
        let items = Array.isArray(request.items) ? request.items : request.libraryPath
          ? await scanItems(request.libraryPath, { signal: controller.signal, checkpoint, onProgress, itemIds: request.itemIds }) : [];
        if (Array.isArray(request.itemIds)) {
          const selected = new Set(request.itemIds);
          items = items.filter(item => selected.has(item.id));
        }
        controller.signal.throwIfAborted();
        const units = buildCaptureUnits(items);
        scan = { items, units };
        if (checkpoint) await checkpoint.put('scanning', scan);
      }
      const { items, units } = scan;
      Object.assign(data, { items, units });
      Object.assign(run, { itemCount: items.length, unitCount: units.length });
      const byId = new Map(items.map(item => [item.id, item]));
      const records = units.map(unit => ({ ...byId.get(unit.primaryItemId), unitId: unit.id,
        itemIds: unit.itemIds, pairedItems: unit.itemIds.map(itemId => byId.get(itemId)).filter(Boolean) }));
      return pipeline.run(records, {
        id,
        signal: controller.signal,
        checkpoint,
        performanceMode: mode,
        onProgress,
      });
    };
    const finished = execute()
      .then(async (result) => {
        clearInterval(heartbeat);
        controller.signal.throwIfAborted();
        const { results: _results, groups: _groups, duplicateCandidates: _duplicates, ...summary } = result;
        Object.assign(run, summary, {
          status: "completed",
          groupCount: result.groups.length,
          selectedCount: result.groups.reduce((n, g) => n + Object.values(g.suggested || {}).filter(v => v === "selected").length, 0),
          rejectedCount: result.groups.reduce((n, g) => n + Object.values(g.suggested || {}).filter(v => v === "rejected").length, 0),
          warnings: result.warnings || [],
        });
        run.progress = tracker.update(result.progress || { stage: 'done',
          completed: result.results?.length || 0, total: result.results?.length || 0 });
        data.results = result.results || [];
        data.groups = result.groups || [];
        data.duplicateCandidates = result.duplicateCandidates;
        delete run.controller;
        run.finishedAt = new Date().toISOString();
        await Promise.all(progressWrites);
        const continuity = run.purpose !== 'prefetch' && store.allRuns && store.dir;
        const unitIds = data.units.map(unit => unit.id);
        // Carry decisions and retire old versions before the completed status becomes visible.
        if (continuity) {
          try {
            const inherited = await inheritDecisions(store, run, unitIds);
            if (inherited.count) run.inherited = inherited;
            const adopted = await store.pendingDecisions?.adopt(run.libraryPath, data.units,
              new DecisionsStore(store.dir(run.id)));
            if (adopted) run.adoptedBeforeAnalysis = adopted;
            if (store.unitIds) await supersedeOlderRuns(store, run, unitIds);
          } catch (error) { run.continuityWarning = error.message; }
        }
        await persist(store, run, data);
        if (active.run?.id === id) active.run = null;
        if (run.purpose === 'prefetch') await store.prunePrefetchRuns?.(5).catch(() => {});
        void onFinished();
      })
      .catch(async (error) => {
        clearInterval(heartbeat);
        run.progress = tracker.snapshot();
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.error = error.message;
        delete run.controller;
        run.finishedAt = new Date().toISOString();
        await Promise.all(progressWrites);
        await persist(store, run, data);
        if (active.run?.id === id) active.run = null;
        if (run.purpose === 'prefetch') await store.prunePrefetchRuns?.(5).catch(() => {});
        void onFinished();
      });
    finishing.set(run, finished);
    const response = runSummary(run);
    return reply(202, response);
  }
  // The analysis queue starts its entries through the same path as POST /runs.
  handleRunsRoute.startRun = startRun;
  async function handleRunsRoute(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/runs/analyzed') {
      const body = await parseBody(req);
      if (!Array.isArray(body.itemIds) || body.itemIds.length > 1000 ||
        !body.itemIds.every(id => typeof id === 'string') || typeof body.libraryPath !== 'string')
        return json(res, 400, { error: 'Invalid candidates' });
      return json(res, 200, { itemIds: await store.analyzedItemIds(body.itemIds, body.libraryPath) });
    }
    if (req.method === 'POST' && url.pathname === '/runs/match') {
      const body = await parseBody(req);
      if (typeof body.libraryPath !== 'string' || !Array.isArray(body.itemIds) || body.itemIds.length > 50000 ||
        !body.itemIds.every(id => typeof id === 'string')) return json(res, 400, { error: 'Invalid scope' });
      const key = scopeKey(body.scope || {}, body.itemIds);
      return json(res, 200, { key, match: store.matchScope ? await store.matchScope({ libraryPath: body.libraryPath,
        itemIds: body.itemIds, key }) : null });
    }
    if (req.method === 'GET' && url.pathname === '/runs/status') {
      const running = activeRun(active);
      const current = running?.purpose === 'prefetch' ? null : running;
      const recent = store.recentRuns ? await store.recentRuns() : [];
      const prefetch = store.latestPrefetch ? await store.latestPrefetch() : null;
      return json(res, 200, { active: current ? runSummary(current) : null,
        prefetch: running?.purpose === 'prefetch' ? runSummary(running) : prefetch && prefetchSummary(prefetch),
        recent: recent.map(run => ({ ...runSummary(run),
          ...(current?.id !== run.id && run.status === 'running' ? { status: 'interrupted' } : {}) })) });
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      const limit = Number(url.searchParams.get('limit') || 20);
      const cursor = Number(url.searchParams.get('cursor') || 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(cursor) || cursor < 0) {
        return json(res, 400, { error: '分页参数无效：limit 为 1–100，cursor 为非负整数' });
      }
      const result = await store.list({ limit, cursor, libraryPath: url.searchParams.get("libraryPath") || undefined,
        includeSuperseded: url.searchParams.get("includeSuperseded") === "1" });
      result.runs = result.runs.map(run => ({ ...run,
        ...(run.status === 'running' && activeRun(active)?.id !== run.id ? { status: 'interrupted' } : {}) }));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      if (isUpdating()) return json(res, 409, { error: "正在更新，请稍后开始分析" });
      const [status, payload] = await startRun(await parseBody(req));
      return json(res, status, payload);
    }

    const match = url.pathname.match(/^\/runs\/([^/]+)(?:\/(.*))?$/);
    if (!match) return false;
    const id = match[1];
    const sub = match[2];
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, 404, { error: "run not found" });
    if (req.method === "GET" && !sub) {
      const run = active.run?.id === id ? runSummary(active.run)
        : store.getRun ? await store.getRun(id) : runFromState(await store.get(id));
      if (run) {
        delete run.controller;
        if (run.status === 'running' && activeRun(active)?.id !== id) run.status = 'interrupted';
      }
      return run
        ? json(res, 200, run)
        : json(res, 404, { error: "run not found" });
    }
    if (req.method === "GET" && ["results", "groups"].includes(sub)) {
      let options;
      try { options = pageOptions(url); } catch (error) { return json(res, 400, { error: error.message }); }
      const paged = sub === 'groups' || (store.manifest && await store.manifest(id)) || [...url.searchParams.keys()].some(key =>
        ['limit', 'cursor', 'filter', 'groupId', 'unitId'].includes(key));
      const state = paged && store.page
        ? await store.page(id, { ...options, summariesOnly: sub === 'groups' }) : await store.get(id, { readOnly: true });
      const run = runFromState(state);
      if (sub === 'groups') return run ? json(res, 200, { run, groups: state.groups, page: state.page })
        : json(res, 404, { error: 'run not found' });
      return run
        ? json(res, 200, {
            run,
            ...(state?.page ? { page: state.page } : {}),
            units: state?.units || [],
            results: (state?.results || []).map(result => ({ ...result, aiTags: resultAiTags(state, result) })),
            groups: reviewGroups(state),
            groupOverrides: state?.groupOverrides,
            writebackAvailable: Boolean(state?.applied?.length),
            items: state?.items || [],
            ...(state?.duplicateCandidates ? { duplicateCandidates: state.duplicateCandidates } : {}),
          })
        : json(res, 404, { error: "run not found" });
    }
    if (req.method === "GET" && sub?.startsWith("preview/")) {
      const unitId = decodeUnitId(sub.slice("preview/".length));
      if (!unitId) return json(res, 404, { error: "preview not found" });
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      const run = runFromState(state);
      const result = state?.results?.find((entry) => entry.unitId === unitId);
      if (!run || !result?.previewPath) {
        return json(res, 404, { error: "preview not found" });
      }
      try {
        const image = await readFile(result.previewPath);
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=3600",
          ...CORS_HEADERS,
        });
        res.end(image);
      } catch {
        return json(res, 404, { error: "preview not found" });
      }
      return true;
    }
    if (req.method === "GET" && sub?.startsWith("detail/")) {
      const unitId = decodeUnitId(sub.slice("detail/".length));
      if (!unitId) return json(res, 404, { error: "detail not found" });
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      const run = runFromState(state);
      if (!run || !state?.units?.some(item => item.id === unitId)) {
        return json(res, 404, { error: "detail not found" });
      }
      const file = await detailImage(store, id, unitId, state);
      if (!file) return json(res, 404, { error: "detail not found" });
      const image = await readFile(file);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=3600",
        ...CORS_HEADERS,
      });
      res.end(image);
      return true;
    }
    if (req.method === 'GET' && sub?.startsWith('display/')) {
      const unitId = decodeUnitId(sub.slice('display/'.length));
      const requested = Number(url.searchParams.get('edge'));
      if (!unitId) return json(res, 404, { error: 'display not found' });
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      const run = runFromState(state);
      if (!run || !state?.units?.some(item => item.id === unitId)) return json(res, 404, { error: 'display not found' });
      try {
        const result = await displayImage(store, id, unitId, state, requested);
        if (!result) return json(res, 404, { error: 'display not found' });
        const image = await readFile(result.path);
        const fallback = result.source === 'eagle-thumbnail' || result.source === 'proxy';
        const headers = { 'content-type': 'image/jpeg', 'cache-control': fallback ? 'no-store' : 'public, max-age=3600',
          'x-display-source': result.source, 'x-display-edge': String(result.edge),
          'access-control-expose-headers': 'x-display-source, x-display-edge, x-display-warning', ...CORS_HEADERS };
        if (result.warning) {
          headers['x-display-warning'] = encodeURIComponent(result.warning);
        }
        res.writeHead(200, headers); res.end(image); return true;
      } catch { return json(res, 404, { error: 'display not found' }); }
    }
    if (req.method === 'GET' && sub?.startsWith('focus-points/')) {
      const unitId = decodeUnitId(sub.slice('focus-points/'.length));
      const state = unitId && (store.unitData ? await store.unitData(id, unitId) : await store.get(id));
      const { primary } = state ? unitRecord(state, unitId) : {};
      if (!primary) return json(res, 404, { error: 'unit not found' });
      const size = { width: Number(primary.width) || null, height: Number(primary.height) || null };
      try { return json(res, 200, { ...await readFocusPoints(primary.filePath || primary.path), ...size }); }
      catch { return json(res, 200, { source: null, areas: [], ...size }); }
    }
    if (req.method === "GET" && sub?.startsWith("face/")) {
      const faceMatch = sub.match(/^face\/([^/]+)\/(0|[1-9]\d*)$/);
      const unitId = faceMatch && decodeUnitId(faceMatch[1]);
      const faceIndex = faceMatch && Number(faceMatch[2]);
      if (!unitId || !Number.isSafeInteger(faceIndex)) return json(res, 404, { error: "face not found" });
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      if (!runFromState(state) || !state?.units?.some(item => item.id === unitId)) {
        return json(res, 404, { error: "face not found" });
      }
      const file = await faceImage(store, id, unitId, faceIndex, state, detailImage);
      if (!file) return json(res, 404, { error: "face not found" });
      try {
        const image = await readFile(file);
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=3600",
          ...CORS_HEADERS,
        });
        res.end(image);
      } catch {
        return json(res, 404, { error: "face not found" });
      }
      return true;
    }
    if (req.method === "POST" && sub?.startsWith("native/") && sub.endsWith("/prefetch")) {
      const unitId = decodeUnitId(sub.slice("native/".length, -"/prefetch".length));
      if (!unitId) return json(res, 404, { error: "unit not found" });
      if (activeRun(active)) return json(res, 200, { available: false, naReason: "analysis-busy" });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error("request closed")); };
      res.on('close', abort); prefetchControllers.add(controller);
      try {
        const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
        const result = await prefetchRegionImage(unitId, state || {}, {
          signal: controller.signal, isBusy: () => Boolean(activeRun(active)),
        });
        if (!controller.signal.aborted) return json(res, 200, {
          available: result.available, cached: result.cached, naReason: result.naReason,
          width: result.width, height: result.height,
        });
      } catch (error) {
        if (!controller.signal.aborted) return json(res, 400, { error: error.message });
      } finally { prefetchControllers.delete(controller); res.off('close', abort); }
      if (!res.destroyed) return json(res, 200, { available: false, naReason: "cancelled" });
      return true;
    }
    if (req.method === "GET" && sub?.startsWith("native/")) {
      const unitId = decodeUnitId(sub.slice("native/".length));
      const box = parseRegionBox(url.searchParams?.get("box"));
      if (!unitId || !box) return json(res, 404, { error: "native region not found" });
      const width = Number(url.searchParams.get('width')), height = Number(url.searchParams.get('height'));
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('request closed')); };
      res.on('close', abort);
      let crop;
      try {
        const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
        if (res.destroyed) return true;
        if (!runFromState(state) || !state?.units?.some(item => item.id === unitId)) {
          return json(res, 404, { error: "native region not found" });
        }
        crop = await regionCropImage(store, id, unitId, box, state, {
          display: { width, height }, signal: controller.signal,
        });
      } finally { res.off('close', abort); }
      if (res.destroyed) return true;
      if (!crop?.available) return json(res, 404, { error: "native region unavailable", naReason: crop?.naReason });
      try {
        const image = crop.buffer || await readFile(crop.path);
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, no-store",
          "x-native-tier": crop.tier, "access-control-expose-headers": "x-native-tier, x-native-width, x-native-height",
          "x-native-width": String(crop.rect.width), "x-native-height": String(crop.rect.height), ...CORS_HEADERS });
        res.end(image);
      } catch { return json(res, 404, { error: "native region not found" }); }
      return true;
    }
    if (req.method === "GET" && sub?.startsWith("focus-crop/")) {
      const match = sub.match(/^focus-crop\/([^/]+)\/(0|[1-9]\d*)$/);
      const unitId = match && decodeUnitId(match[1]);
      const faceIndex = match && Number(match[2]);
      const region = url.searchParams?.get("region") || "face";
      if (!unitId || !Number.isSafeInteger(faceIndex) || !["face", "eyes"].includes(region)) {
        return json(res, 404, { error: "focus crop not found" });
      }
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      if (!runFromState(state) || !state?.units?.some(item => item.id === unitId)) {
        return json(res, 404, { error: "focus crop not found" });
      }
      const crop = await focusCropImage(store, id, unitId, faceIndex, region, state);
      if (!crop?.available) return json(res, 404, { error: "focus crop unavailable", naReason: crop?.naReason });
      try {
        const image = await readFile(crop.path);
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600",
          "x-native-width": String(crop.rect.width), "x-native-height": String(crop.rect.height), ...CORS_HEADERS });
        res.end(image);
      } catch { return json(res, 404, { error: "focus crop not found" }); }
      return true;
    }
    if (req.method === "POST" && sub === "cancel") {
      const run = store.getRun ? await store.getRun(id) : runFromState(await store.get(id));
      if (!run) return json(res, 404, { error: "run not found" });
      if (!["queued", "running"].includes(run.status)) return json(res, 409, { error: "任务已结束，不能取消" });
      if (active.run?.id === id) {
        active.run.controller?.abort(new Error("cancelled"));
      }
      run.status = "cancelled";
      await store.saveProgress(run);
      return json(res, 200, run);
    }
    return false;
  }
  return handleRunsRoute;
}
