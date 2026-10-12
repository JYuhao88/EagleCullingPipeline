import { RunProgress, measuredWeights } from '../core/run-progress.js';
import { Checkpoints } from "../core/checkpoints.js";
import { pageOptions } from "./pagination.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import sharp from "sharp";
import { listEagleImages } from "../core/metrics.js";
import { buildCaptureUnits } from "../core/capture-units.js";
import { groupConfidence, CONFIDENCE_MARGIN_THRESHOLD } from "../core/ranking.js";
import { CORS_HEADERS, json, parseBody } from "./http.js";
import { faceImage } from "./face-image.js";
import { focusCropImage, parseRegionBox, regionCropImage } from "./focus-image.js";

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
    return file;
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
    for (const candidate of [...new Set([source, result.previewPath].filter(Boolean))]) {
      try {
        const ext = path.extname(candidate).toLowerCase();
        if (ext === ".heic" && process.platform === "darwin") {
          const converted = `${file}.sips.jpg`;
          await new Promise((resolve, reject) => {
            const child = spawn("sips", ["-s", "format", "jpeg", "-Z", "2048", candidate, "--out", converted]);
            child.on("error", reject);
            child.on("close", code => code === 0 ? resolve() : reject(new Error(`sips exited ${code}`)));
          });
          // sips keeps the EXIF orientation tag instead of rotating pixels; face boxes assume upright pixels.
          await sharp(converted).rotate().jpeg({ quality: 90 }).toFile(file);
          await rm(converted, { force: true });
        } else {
          await sharp(candidate, { failOn: "none" }).rotate().resize({
            width: 2048, height: 2048, fit: "inside", withoutEnlargement: true
          }).jpeg({ quality: 90 }).toFile(file);
        }
        return file;
      } catch {
        continue;
      }
    }
    return null;
  }
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
  isUpdating = () => false,
} = {}) {
  return async function handleRunsRoute(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/runs/status') {
      const current = activeRun(active);
      const recent = store.recentRuns ? await store.recentRuns() : [];
      return json(res, 200, { active: current ? runSummary(current) : null,
        recent: recent.map(run => ({ ...runSummary(run),
          ...(current?.id !== run.id && run.status === 'running' ? { status: 'interrupted' } : {}) })) });
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      const limit = Number(url.searchParams.get('limit') || 20);
      const cursor = Number(url.searchParams.get('cursor') || 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(cursor) || cursor < 0) {
        return json(res, 400, { error: '分页参数无效：limit 为 1–100，cursor 为非负整数' });
      }
      const result = await store.list({ limit, cursor });
      result.runs = result.runs.map(run => ({ ...run,
        ...(run.status === 'running' && activeRun(active)?.id !== run.id ? { status: 'interrupted' } : {}) }));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      if (isUpdating()) return json(res, 409, { error: "正在更新，请稍后开始分析" });
      if (activeRun(active)) {
        return json(res, 409, { error: "已有分析任务运行中", run: runSummary(activeRun(active)) });
      }
      const body = await parseBody(req);
      const resumeId = body.resumeRunId;
      if (resumeId && !/^[a-zA-Z0-9_-]+$/.test(resumeId)) return json(res, 400, { error: 'Invalid resumeRunId' });
      const previousRun = resumeId ? await store.getRun(resumeId) : null;
      if (resumeId && (!previousRun || previousRun.status === 'completed')) {
        return json(res, 409, { error: 'Run missing or already completed' });
      }
      const id = resumeId || `run-${randomUUID()}`;
      const checkpoint = store.dir ? new Checkpoints(store.dir(id)) : null;
      const request = resumeId ? await checkpoint?.get('request') : body;
      if (!request) return json(res, 409, { error: 'No resumable scan checkpoint' });
      if (!resumeId && checkpoint) await checkpoint.put('request', body);
      const history = store.list ? (await store.list({ limit: 20, cursor: 0 })).runs || [] : [];
      const tracker = new RunProgress({ weights: measuredWeights(history) || undefined });
      const run = {
        contractVersion: 1,
        id,
        status: "running",
        startedAt: new Date().toISOString(),
        progress: tracker.update({ completed: 0, total: 0, cached: 0, stage: 'scanning' }),
        libraryPath: request.libraryPath || null,
        ...(request.scope && ['selection', 'folder', 'library'].includes(request.scope.type) ? { scope: {
          type: request.scope.type, label: String(request.scope.label || '').slice(0, 200),
          ...(typeof request.scope.folderId === 'string' ? { folderId: request.scope.folderId.slice(0, 200) } : {}),
        } } : {}),
        itemCount: 0,
        unitCount: 0,
        groupCount: 0,
      };
      const data = { units: [], items: [], results: [], groups: [] };
      const controller = new AbortController();
      run.controller = controller;
      if (isUpdating()) return json(res, 409, { error: "正在更新，请稍后开始分析" });
      active.run = run;
      if (store.saveProgress) await store.saveProgress(run);
      else await store.save(run, { run });
      let lastProgressAt = 0;
      let lastProgressStage;
      const progressWrites = new Set();
      const onProgress = progress => {
        run.progress = tracker.update(progress);
        const now = performance.now();
        if (progress.stage !== lastProgressStage || now - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = now;
          lastProgressStage = progress.stage;
          const pending = (store.saveProgress ? store.saveProgress(run) : store.save(run, { run })).catch(error => {
            run.progressWarning = error.message;
          }).finally(() => progressWrites.delete(pending));
          progressWrites.add(pending);
        }
      };
      const heartbeat = setInterval(() => onProgress(tracker.last), 1000);
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
          onProgress,
        });
      };
      execute()
        .then(async (result) => {
          clearInterval(heartbeat);
          controller.signal.throwIfAborted();
          const { results: _results, groups: _groups, duplicateCandidates: _duplicates, ...summary } = result;
          Object.assign(run, summary, {
            status: "completed",
            groupCount: result.groups.length,
            warnings: result.warnings || [],
          });
          run.progress = tracker.update(result.progress || { stage: 'done',
            completed: result.results?.length || 0, total: result.results?.length || 0 });
          data.results = result.results || [];
          data.groups = result.groups || [];
          data.duplicateCandidates = result.duplicateCandidates;
          delete run.controller;
          await Promise.all(progressWrites);
          await persist(store, run, data);
          if (active.run?.id === id) active.run = null;
        })
        .catch(async (error) => {
          clearInterval(heartbeat);
          run.progress = tracker.snapshot();
          run.status = controller.signal.aborted ? "cancelled" : "failed";
          run.error = error.message;
          delete run.controller;
          await Promise.all(progressWrites);
          await persist(store, run, data);
          if (active.run?.id === id) active.run = null;
        });
      const response = runSummary(run);
      return json(res, 202, response);
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
            results: state?.results || [],
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
    if (req.method === "GET" && sub?.startsWith("native/")) {
      const unitId = decodeUnitId(sub.slice("native/".length));
      const box = parseRegionBox(url.searchParams?.get("box"));
      if (!unitId || !box) return json(res, 404, { error: "native region not found" });
      const state = store.unitData ? await store.unitData(id, unitId) : await store.get(id);
      if (!runFromState(state) || !state?.units?.some(item => item.id === unitId)) {
        return json(res, 404, { error: "native region not found" });
      }
      const crop = await regionCropImage(store, id, unitId, box, state);
      if (!crop?.available) return json(res, 404, { error: "native region unavailable", naReason: crop?.naReason });
      try {
        const image = await readFile(crop.path);
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600",
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
  };
}
