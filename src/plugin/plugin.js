import {
  REVIEW_STATES,
  buildReviewSections,
  matchesReviewFilter,
  mergeReviewStateTags,
  summarize,
} from "./review-model.js";
import { runBoundedQueue } from "./task-queue.js";

const SERVICE_URL = "http://127.0.0.1:43125";
const MAX_BATCH_SIZE = 500;
const PLUGIN_VERSION = "0.3.0";
const MODE_KEY = "eagle-culling-preview-mode";
const eagleApi = globalThis.eagle;
const demoMode = !eagleApi && new URLSearchParams(location.search).has("demo");

const elements = {
  status: document.querySelector("#status"),
  service: document.querySelector("#service-state"),
  inspect: document.querySelector("#inspect"),
  analyze: document.querySelector("#analyze"),
  badges: document.querySelector("#badges"),
  allBadges: document.querySelector("#all-badges"),
  restoreBadges: document.querySelector("#restore-badges"),
  views: document.querySelector("#views"),
  panels: document.querySelectorAll(".view-panel"),
  modeNative: document.querySelector("#mode-native"),
  modeBadge: document.querySelector("#mode-badge"),
  modeState: document.querySelector("#mode-state"),
  concurrency: document.querySelector("#concurrency"),
  delay: document.querySelector("#delay"),
  taskPause: document.querySelector("#task-pause"),
  taskResume: document.querySelector("#task-resume"),
  taskRetry: document.querySelector("#task-retry"),
  taskCurrent: document.querySelector("#task-current"),
  taskProgressBar: document.querySelector("#task-progress-bar"),
  taskCompleted: document.querySelector("#task-completed"),
  taskSuccess: document.querySelector("#task-success"),
  taskSkipped: document.querySelector("#task-skipped"),
  taskFailed: document.querySelector("#task-failed"),
  taskSpeed: document.querySelector("#task-speed"),
  taskEta: document.querySelector("#task-eta"),
  taskError: document.querySelector("#task-error"),
  taskHistory: document.querySelector("#task-history"),
  migrationNote: document.querySelector("#migration-note"),
  serviceVersion: document.querySelector("#service-version"),
  serviceError: document.querySelector("#service-error"),
  reload: document.querySelector("#reload"),
  diagnostics: document.querySelector("#diagnostics"),
  search: document.querySelector("#search"),
  filters: document.querySelector("#filters"),
  empty: document.querySelector("#empty-state"),
  list: document.querySelector("#review-list"),
  summary: {
    total: document.querySelector("#summary-total"),
    selected: document.querySelector("#summary-selected"),
    candidate: document.querySelector("#summary-candidate"),
    rejected: document.querySelector("#summary-rejected"),
    issues: document.querySelector("#summary-issues"),
  },
};

const state = { items: [], groups: [], liveItems: new Map(), filter: "all", focusedId: null, mode: localStorage.getItem(MODE_KEY) || "native", tasks: [], activeTask: null, running: false, paused: false, cancelled: false, taskStartedAt: 0 };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function snapshotItem(item) {
  return {
    id: item.id,
    name: item.name,
    ext: item.ext,
    filePath: item.filePath,
    fileURL: item.fileURL,
    thumbnailPath: item.thumbnailPath,
    thumbnailURL: item.thumbnailURL,
    width: item.width,
    height: item.height,
    tags: [...(item.tags || [])],
    folders: [...(item.folders || [])],
    star: item.star,
    modifiedAt: item.modifiedAt,
  };
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function setServiceState(serviceState, text) {
  elements.service.dataset.state = serviceState;
  elements.service.querySelector("span:last-child").textContent = text;
}

function setBusy(isBusy) {
  elements.inspect.disabled = isBusy;
  elements.analyze.disabled = isBusy;
  elements.badges.disabled = isBusy || demoMode;
  elements.allBadges.disabled = isBusy || demoMode;
  elements.restoreBadges.disabled = isBusy || demoMode;
}

function setView(view) {
  elements.panels.forEach((panel) => { panel.hidden = panel.id !== `view-${view}`; });
  elements.views.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem(MODE_KEY, mode);
  elements.modeNative.classList.toggle("is-active", mode === "native");
  elements.modeBadge.classList.toggle("is-active", mode === "badge");
  elements.modeState.textContent = `当前模式：${mode === "badge" ? "角标分拣" : "原生预览"}`;
}

function manifestEntries(manifest) {
  const raw = manifest?.items || manifest?.entries || [];
  if (Array.isArray(raw)) return raw.map((entry) => [entry.id || entry.itemId || entry.badgeKey, entry]).filter(([id]) => id);
  return Object.entries(raw);
}

async function serviceRequest(pathname, options = {}) {
  const response = await fetch(`${SERVICE_URL}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function allRecords() {
  return buildReviewSections(state.items, state.groups).flatMap((section) => section.records);
}

function visibleSections() {
  const query = elements.search.value;
  return buildReviewSections(state.items, state.groups)
    .map((section) => ({ ...section, records: section.records.filter((record) => matchesReviewFilter(record, state.filter, query)) }))
    .filter((section) => section.records.length > 0);
}

function renderRecord(record) {
  const score = Number.isFinite(record.qualityScore) ? `${Math.round(record.qualityScore)} 分` : "未评分";
  const dimensions = record.width && record.height ? `${record.width}×${record.height}` : "尺寸未知";
  const reasons = record.reasons.slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const visibleTags = (record.tags || [])
    .filter((tag) => tag.startsWith("AI") || tag === "待复核")
    .slice(0, 8)
    .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
    .join("");
  const thumbnail = record.thumbnailURL || record.fileURL || "";
  const thumbnailMarkup = thumbnail
    ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(record.name)} 的缩略图" loading="lazy">`
    : `<span class="format-badge">${escapeHtml((record.ext || "文件").toUpperCase())}</span>`;
  const actionLabels = { selected: "精选", candidate: "候选", rejected: "待复核" };
  const decisionButtons = ["selected", "candidate", "rejected"].map((key) => (
    `<button class="decision-button${record.state === key ? " is-current" : ""}" type="button" data-action="${key}" data-id="${escapeHtml(record.id)}"${demoMode ? " disabled" : ""}>${actionLabels[key]}</button>`
  )).join("");
  return `
    <article class="item-row${state.focusedId === record.id ? " is-focused" : ""}" data-record-id="${escapeHtml(record.id)}" tabindex="0">
      <button class="thumbnail-button" type="button" data-action="locate" data-id="${escapeHtml(record.id)}" aria-label="在 Eagle 中定位 ${escapeHtml(record.name)}">${thumbnailMarkup}</button>
      <div class="item-content">
        <div class="item-title-line">
          <h3 class="item-title" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</h3>
          <span class="format-badge">${escapeHtml((record.ext || "文件").toUpperCase())}</span>
          <span class="state-badge" data-state="${record.state}">${escapeHtml(record.stateLabel)}</span>
        </div>
        <p class="item-meta">${score} · ${dimensions}${record.star ? ` · Eagle ${record.star} 星` : ""}</p>
        ${visibleTags ? `<div class="tag-list" aria-label="照片标签">${visibleTags}</div>` : ""}
        <ul class="reason-list">${reasons}</ul>
      </div>
      <div class="item-review">
        <div class="recommendation"><span>AI 建议</span><span class="recommendation-badge">${escapeHtml(record.recommendationLabel)}</span></div>
        <div class="decision-buttons" aria-label="设置审阅状态">${decisionButtons}</div>
        <button class="locate-button" type="button" data-action="locate" data-id="${escapeHtml(record.id)}">在 Eagle 中定位</button>
      </div>
    </article>`;
}

function render() {
  const records = allRecords();
  const totals = summarize(records);
  Object.entries(totals).forEach(([key, value]) => { elements.summary[key].textContent = String(value); });
  const sections = visibleSections();
  const visibleCount = sections.reduce((sum, section) => sum + section.records.length, 0);
  elements.empty.hidden = visibleCount > 0;
  elements.list.hidden = visibleCount === 0;
  if (visibleCount === 0) {
    elements.empty.querySelector("h2").textContent = records.length ? "没有符合条件的照片" : "请先在 Eagle 中选择照片";
    elements.empty.querySelector("p").textContent = records.length ? "切换状态筛选或清空搜索词后再看。" : "建议一次选择同一次拍摄或同一组连拍，单批不超过 500 张。";
    elements.list.innerHTML = "";
    return;
  }
  elements.list.innerHTML = sections.map((section) => `
    <section class="review-group" aria-labelledby="heading-${escapeHtml(section.id)}">
      <div class="group-heading"><h2 id="heading-${escapeHtml(section.id)}">${escapeHtml(section.title)}</h2><p>${escapeHtml(section.note)}</p></div>
      <div class="group-items">${section.records.map(renderRecord).join("")}</div>
    </section>`).join("");
}

function renderTasks() {
  const task = state.activeTask || state.tasks[0];
  if (!task) {
    elements.taskCurrent.textContent = "暂无运行中的任务";
    elements.taskProgressBar.style.width = "0%";
    elements.taskCompleted.textContent = "0 / 0";
    return;
  }
  const summary = task.summary || {};
  const total = Number(summary.total || task.items?.length || 0);
  const completed = Number(summary.succeeded || 0) + Number(summary.skipped || 0) + Number(summary.failed || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  elements.taskCurrent.textContent = `${task.taskType} · ${task.status}`;
  elements.taskProgressBar.style.width = `${percent}%`;
  elements.taskCompleted.textContent = `${completed} / ${total}`;
  elements.taskSuccess.textContent = `成功 ${summary.succeeded || 0}`;
  elements.taskSkipped.textContent = `跳过 ${summary.skipped || 0}`;
  elements.taskFailed.textContent = `失败 ${summary.failed || 0}`;
  elements.taskSpeed.textContent = state.taskStartedAt && completed ? `${(completed / Math.max(1, (Date.now() - state.taskStartedAt) / 1000)).toFixed(1)} 项/秒` : "—";
  elements.taskEta.textContent = completed && total > completed && state.taskStartedAt ? `剩余约 ${Math.ceil(((Date.now() - state.taskStartedAt) / completed) * (total - completed) / 1000)} 秒` : "—";
  elements.taskError.textContent = task.error || (task.errors?.length ? task.errors.at(-1).error : `最近更新：${new Date(task.updatedAt).toLocaleTimeString()}`);
  elements.taskHistory.innerHTML = state.tasks.slice(0, 8).map((entry) => `<div class="task-history-row"><span>${escapeHtml(entry.taskType)} · ${escapeHtml(entry.taskId)}</span><span>${escapeHtml(entry.status)} · ${entry.summary?.succeeded || 0}/${entry.summary?.total || entry.items?.length || 0}</span></div>`).join("");
}

async function checkService() {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const version = await serviceRequest("/version");
    elements.serviceVersion.textContent = version.version || "未知";
    elements.serviceError.textContent = `服务已连接 · 入口：scripts/start-service.ps1`;
    setServiceState("ready", "本地分析服务已连接");
    try {
      const manifest = await serviceRequest("/badge-manifest");
      const count = manifestEntries(manifest).filter(([, entry]) => entry && entry.outputPath && !entry.skipped).length;
      elements.migrationNote.textContent = count ? `发现旧版角标清单（${count} 项）。迁移不会自动恢复或删除，可在任务中选择模式。` : "未发现旧版角标清单，新的任务会自动登记归属。";
    } catch {
      elements.migrationNote.textContent = "暂无旧版角标清单；服务恢复后会自动检查。";
    }
  } catch (error) {
    elements.serviceVersion.textContent = "未连接";
    elements.serviceError.textContent = `服务未启动：${error.message}。可运行 scripts/start-service.ps1`;
    setServiceState("offline", "分析服务未启动");
  }
}

async function refreshTasks() {
  if (!eagleApi) return;
  try {
    const payload = await serviceRequest("/tasks");
    state.tasks = payload.tasks || [];
    const active = state.tasks.find((task) => ["pending", "running", "paused"].includes(task.status));
    if (active && !state.running) {
      state.activeTask = active.items ? active : await serviceRequest(`/tasks/${active.taskId}`);
      if (["pending", "running"].includes(state.activeTask.status)) resumeStoredTask(state.activeTask);
    }
    renderTasks();
  } catch { /* status is already represented by the service indicator */ }
}

async function resumeStoredTask(task) {
  if (state.running || !eagleApi) return;
  state.running = true;
  state.taskStartedAt = Date.now();
  try {
    const allItems = await eagleApi.item.getAll();
    const itemMap = new Map(allItems.map((item) => [item.id, item]));
    setStatus(`正在从断点继续任务：${task.taskId}…`, "neutral");
    await runTask(task, itemMap);
  } catch (error) {
    state.running = false;
    setStatus(`断点恢复失败：${error.message}`, "error");
  }
}

async function loadSelection() {
  if (!eagleApi) return;
  setBusy(true);
  setStatus("正在读取 Eagle 当前选择…");
  try {
    const selected = await eagleApi.item.getSelected();
    state.liveItems = new Map(selected.map((item) => [item.id, item]));
    state.items = selected.map(snapshotItem);
    state.groups = [];
    state.focusedId = state.items[0]?.id || null;
    render();
    setStatus(selected.length ? `已读取 ${selected.length} 张照片。可直接复核已有标签，或运行本地 AI 分析。` : "当前没有选择照片，请先回到 Eagle 选择一组照片。", selected.length ? "success" : "neutral");
  } catch (error) {
    setStatus(`读取失败：${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function analyzeSelection() {
  if (!eagleApi) return;
  setBusy(true);
  setStatus("正在读取选择并分析缩略图；原始照片保持不变…");
  try {
    const selected = await eagleApi.item.getSelected();
    if (selected.length === 0) throw new Error("请先在 Eagle 中选择照片");
    if (selected.length > MAX_BATCH_SIZE) throw new Error(`一次最多分析 ${MAX_BATCH_SIZE} 张，当前选择了 ${selected.length} 张`);
    state.liveItems = new Map(selected.map((item) => [item.id, item]));
    const sourceItems = selected.map(snapshotItem).filter((item) => item.filePath);
    const requestItems = sourceItems.map((item) => ({ ...item, analysisPath: item.thumbnailPath || item.filePath }));
    const response = await fetch(`${SERVICE_URL}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: requestItems, includeFaces: true }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const sourceById = new Map(sourceItems.map((item) => [item.id, item]));
    state.items = payload.items.map((item) => ({ ...sourceById.get(item.id), ...item }));
    state.groups = payload.groups || [];
    state.focusedId = state.items[0]?.id || null;
    render();
    const similarCount = state.groups.filter((group) => group.size > 1).length;
    setServiceState("ready", "本地分析服务已连接");
    setStatus(`分析完成：${state.items.length} 张照片，${similarCount} 个多图相似组。结果仅供审阅，尚未写入新状态。`, "success");
  } catch (error) {
    setServiceState("offline", "分析服务不可用");
    setStatus(`分析失败：${error.message}。请在项目目录运行 npm run serve。`, "error");
  } finally {
    setBusy(false);
  }
}

function taskItemsFromEagle(items) {
  const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "3fr", "arw", "dng", "cr2", "cr3", "nef", "raf", "orf", "rw2", "tif", "tiff"]);
  return items.filter((item) => imageExtensions.has(String(item.ext || "").toLowerCase().replace(/^\./, "")) && (item.thumbnailPath || item.filePath)).map((item) => ({ id: item.id, modifiedAt: item.modifiedAt || null, sourcePath: item.thumbnailPath || item.filePath, status: "pending", attempts: 0 }));
}

async function createTask(taskType, items) {
  if (!items.length) throw new Error("当前没有可处理的图片");
  const task = await serviceRequest("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType, status: "running", libraryPath: "Eagle 当前资源库", manifestVersion: PLUGIN_VERSION, config: { concurrency: Number(elements.concurrency.value), delayMs: Number(elements.delay.value), maxAttempts: 3 }, items: taskItemsFromEagle(items) }) });
  state.activeTask = task;
  state.taskStartedAt = Date.now();
  state.running = true;
  state.paused = false;
  state.cancelled = false;
  renderTasks();
  runTask(task, new Map(items.map((item) => [item.id, item]))).catch((error) => setStatus(`任务失败：${error.message}`, "error"));
}

async function runTask(task, itemMap) {
  try {
    const byId = new Map((task.items || []).map((entry) => [entry.id, entry]));
    let sinceCheckpoint = 0;
    const pendingPersistence = new Set();
    const result = await runBoundedQueue({
      items: task.items || [],
      concurrency: task.config?.concurrency || 2,
      delayMs: task.config?.delayMs ?? 120,
      maxAttempts: task.config?.maxAttempts || 3,
      shouldSkip: (entry) => byId.get(entry.id)?.status === "succeeded" || byId.get(entry.id)?.status === "skipped",
      shouldPause: () => state.paused,
      shouldCancel: () => state.cancelled,
      process: async (entry, attempt) => {
        const item = itemMap.get(entry.id) || await eagleApi.item.getById(entry.id);
        if (!item) throw new Error("Eagle 项目不存在");
        if (task.taskType === "restore-thumbnails") {
          if (typeof item.refreshThumbnail !== "function") throw new Error("当前 Eagle API 不支持 refreshThumbnail");
          await item.refreshThumbnail();
          return;
        }
        if (task.taskType === "analyze-selection") {
          const snapshot = snapshotItem(item);
          const analyzed = await serviceRequest("/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ ...snapshot, analysisPath: snapshot.thumbnailPath || snapshot.filePath }], includeFaces: true }) });
          const current = state.items.find((entry) => entry.id === item.id);
          if (current && analyzed.items?.[0]) Object.assign(current, analyzed.items[0]);
          state.groups = analyzed.groups || state.groups;
          render();
          return;
        }
        const payload = await serviceRequest("/badge-thumbnail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ badgeKey: item.id, sourcePath: item.thumbnailPath || item.filePath, tags: item.tags || [] }) });
        if (payload.outputPath && !payload.skipped && typeof item.setCustomThumbnail === "function") {
          await item.setCustomThumbnail(payload.outputPath);
          entry.outputPath = payload.outputPath;
        }
        entry.attempts = attempt;
      },
      onProgress: async (progress) => {
        const patch = { status: progress.status, attempts: progress.attempts, error: progress.error || null, outputPath: progress.item.outputPath || null };
        Object.assign(byId.get(progress.item.id) || {}, patch);
        pendingPersistence.add(progress.item.id);
        sinceCheckpoint += 1;
        if (progress.status === "failed" || sinceCheckpoint >= 25) {
          await serviceRequest(`/tasks/${task.taskId}/checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [...pendingPersistence].map((itemId) => { const entry = byId.get(itemId); return { itemId, status: entry.status, attempts: entry.attempts, error: entry.error, outputPath: entry.outputPath }; }) }) });
          pendingPersistence.clear();
          sinceCheckpoint = 0;
        }
        const localSummary = { total: task.items.length, succeeded: task.items.filter((entry) => entry.status === "succeeded").length, skipped: task.items.filter((entry) => entry.status === "skipped").length, failed: task.items.filter((entry) => entry.status === "failed").length };
        state.activeTask = { ...state.activeTask, items: task.items, summary: localSummary };
        renderTasks();
      },
    });
    for (const itemId of pendingPersistence) {
      const entry = byId.get(itemId);
      await serviceRequest(`/tasks/${task.taskId}/checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ itemId, status: entry.status, attempts: entry.attempts, error: entry.error, outputPath: entry.outputPath }] }) });
    }
    const status = state.cancelled ? "cancelled" : state.paused ? "paused" : result.failed ? "failed" : "succeeded";
    if (status === "succeeded") await serviceRequest(`/tasks/${task.taskId}/complete`, { method: "POST" });
    else if (status === "paused") await serviceRequest(`/tasks/${task.taskId}/pause`, { method: "POST" });
    else if (status === "cancelled") await serviceRequest(`/tasks/${task.taskId}/cancel`, { method: "POST" });
    else await serviceRequest(`/tasks/${task.taskId}/fail`, { method: "POST" });
    state.activeTask = await serviceRequest(`/tasks/${task.taskId}`);
    state.running = false;
    setBusy(false);
    setStatus(status === "succeeded" ? `任务完成：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed}。` : `任务${status === "paused" ? "已暂停" : "已取消"}，可在任务页继续。`, status === "succeeded" ? "success" : "neutral");
    await refreshTasks();
  } catch (error) {
    state.running = false;
    setBusy(false);
    if (task?.taskId) await serviceRequest(`/tasks/${task.taskId}/fail`, { method: "POST" }).catch(() => {});
    setStatus(`任务失败：${error.message}`, "error");
  }
}

async function generateBadges() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getSelected();
    if (!selected.length) throw new Error("请先在 Eagle 中选择照片");
    setView("tasks"); setBusy(true); await createTask("badge-thumbnails-selection", selected);
    setStatus(`已创建当前选择的角标任务（${selected.length} 项），可在任务页暂停或继续。`, "success");
  } catch (error) { setBusy(false); setStatus(`角标任务创建失败：${error.message}`, "error"); }
}

async function analyzeAsTask() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getSelected();
    if (!selected.length) throw new Error("请先在 Eagle 中选择照片");
    if (selected.length > MAX_BATCH_SIZE) throw new Error(`一次最多分析 ${MAX_BATCH_SIZE} 张，当前选择了 ${selected.length} 张`);
    state.liveItems = new Map(selected.map((item) => [item.id, item]));
    state.items = selected.map(snapshotItem);
    render();
    setView("tasks"); setBusy(true); await createTask("analyze-selection", selected);
    setStatus(`已创建 AI 分析任务（${selected.length} 项），结果会逐项回填审阅区。`, "success");
  } catch (error) { setBusy(false); setStatus(`分析任务创建失败：${error.message}`, "error"); }
}

async function generateAllBadges() {
  if (!eagleApi) return;
  try {
    const allItems = await eagleApi.item.getAll();
    setView("tasks"); setBusy(true); await createTask("badge-thumbnails-library", allItems);
    setStatus(`已创建全库角标任务（${allItems.length} 项），默认并发 ${elements.concurrency.value}。`, "success");
  } catch (error) { setBusy(false); setStatus(`全库任务创建失败：${error.message}`, "error"); }
}

async function restoreBadges() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getSelected();
    const manifest = await serviceRequest("/badge-manifest");
    const ownedIds = new Set(manifestEntries(manifest).filter(([, entry]) => entry?.outputPath && !entry.skipped).map(([id]) => id));
    const owned = selected.filter((item) => ownedIds.has(item.id));
    if (!owned.length) throw new Error("当前选择中没有本工具登记过的角标；为保护人工缩略图，未执行恢复");
    setView("tasks"); setBusy(true); await createTask("restore-thumbnails", owned);
    setStatus(`已创建安全恢复任务（${owned.length} 项），只处理本工具登记的角标。`, "success");
  } catch (error) { setBusy(false); setStatus(`恢复任务创建失败：${error.message}`, "error"); }
}

async function locateItem(id) {
  if (demoMode) {
    setStatus("当前是界面演示模式；在 Eagle 插件中会定位到对应照片。", "neutral");
    return;
  }
  try {
    await eagleApi.item.select([id]);
    await eagleApi.item.open(id);
    setStatus("已在 Eagle 中定位照片。", "success");
  } catch (error) {
    setStatus(`定位失败：${error.message}`, "error");
  }
}

async function applyReviewState(id, reviewState) {
  if (!eagleApi) return;
  const label = REVIEW_STATES[reviewState].label;
  setStatus(`正在写入“${label}”标签…`);
  try {
    const item = await eagleApi.item.getById(id);
    item.tags = mergeReviewStateTags(item.tags || [], reviewState);
    await item.save();
    const current = state.items.find((entry) => entry.id === id);
    if (current) current.tags = [...item.tags];
    state.liveItems.set(id, item);
    render();
    setStatus(`已标记为“${label}”。人工标签、配对标签、星级和文件夹均未改动。`, "success");
  } catch (error) {
    setStatus(`写入失败：${error.message}`, "error");
  }
}

function focusRecord(id) {
  state.focusedId = id;
  document.querySelectorAll(".item-row.is-focused").forEach((element) => element.classList.remove("is-focused"));
  const row = document.querySelector(`[data-record-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add("is-focused");
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function moveFocus(delta) {
  const ids = visibleSections().flatMap((section) => section.records.map((record) => record.id));
  if (!ids.length) return;
  const currentIndex = Math.max(0, ids.indexOf(state.focusedId));
  focusRecord(ids[Math.max(0, Math.min(ids.length - 1, currentIndex + delta))]);
}

function bindEvents() {
  elements.views.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });
  elements.inspect.addEventListener("click", loadSelection);
  elements.analyze.addEventListener("click", analyzeAsTask);
  elements.badges.addEventListener("click", generateBadges);
  elements.allBadges.addEventListener("click", generateAllBadges);
  elements.restoreBadges.addEventListener("click", restoreBadges);
  elements.modeNative.addEventListener("click", () => setMode("native"));
  elements.modeBadge.addEventListener("click", () => setMode("badge"));
  elements.taskPause.addEventListener("click", async () => {
    if (!state.activeTask) return;
    state.paused = true;
    await serviceRequest(`/tasks/${state.activeTask.taskId}/pause`, { method: "POST" }).catch(() => {});
    renderTasks();
    setStatus("任务已暂停；当前请求完成后停止，点击继续可从断点恢复。", "neutral");
  });
  elements.taskResume.addEventListener("click", async () => {
    if (!state.activeTask) return;
    state.paused = false;
    const task = await serviceRequest(`/tasks/${state.activeTask.taskId}/resume`, { method: "POST" }).catch(() => null);
    if (task) { state.activeTask = task; state.running = false; await resumeStoredTask(task); }
  });
  elements.taskRetry.addEventListener("click", async () => {
    if (!state.activeTask) return;
    const task = await serviceRequest(`/tasks/${state.activeTask.taskId}/retry`, { method: "POST" }).catch(() => null);
    if (task) { state.activeTask = task; state.paused = false; state.running = false; await resumeStoredTask(task); }
  });
  elements.reload.addEventListener("click", () => location.reload());
  elements.diagnostics.addEventListener("click", async () => {
    const report = { pluginVersion: PLUGIN_VERSION, serviceUrl: SERVICE_URL, mode: state.mode, taskCount: state.tasks.length, tasks: state.tasks, userAgent: navigator.userAgent, generatedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "eagle-culling-diagnostics.json"; link.click(); URL.revokeObjectURL(url);
    setStatus("诊断报告已导出。", "success");
  });
  elements.search.addEventListener("input", render);
  elements.filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    elements.filters.querySelectorAll(".filter-button").forEach((entry) => entry.classList.toggle("is-active", entry === button));
    render();
  });
  elements.list.addEventListener("focusin", (event) => {
    const row = event.target.closest("[data-record-id]");
    if (row) state.focusedId = row.dataset.recordId;
  });
  elements.list.addEventListener("click", async (event) => {
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const { action, id } = control.dataset;
    state.focusedId = id;
    if (action === "locate") await locateItem(id);
    else await applyReviewState(id, action);
  });
  document.addEventListener("keydown", async (event) => {
    if (event.target.matches("input, button")) return;
    if (["j", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveFocus(1); }
    if (["k", "ArrowUp"].includes(event.key)) { event.preventDefault(); moveFocus(-1); }
    if (event.key === "Enter" && state.focusedId) { event.preventDefault(); await locateItem(state.focusedId); }
    const shortcutState = { "1": "selected", "2": "candidate", "3": "rejected" }[event.key];
    if (shortcutState && state.focusedId) { event.preventDefault(); await applyReviewState(state.focusedId, shortcutState); }
  });
}

function svgThumbnail(label, colors) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="220" cy="70" r="35" fill="#fff" opacity=".34"/><path d="M0 205L95 108l54 62 42-40 129 110H0z" fill="#081015" opacity=".45"/><text x="18" y="30" fill="#fff" font-family="sans-serif" font-size="16">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function loadDemo() {
  const base = [
    { id: "demo-1", name: "DSC08421", ext: "JPG", qualityScore: 91, width: 7728, height: 5152, tags: ["旅行", "AI精选", "AI已配对"], qualityFlags: [], thumbnailURL: svgThumbnail("DSC08421", ["#997053", "#263f4b"]) },
    { id: "demo-2", name: "DSC08422", ext: "ARW", qualityScore: 82, width: 7728, height: 5152, tags: ["AI原片", "AI已配对", "AI候选"], qualityFlags: ["possibly-blurry"], analysisSource: "proxy", thumbnailURL: svgThumbnail("DSC08422", ["#6d544a", "#1c3038"]) },
    { id: "demo-3", name: "B0001731", ext: "3FR", qualityScore: 76, width: 11656, height: 8742, tags: ["AI原片", "AI配对待确认"], qualityFlags: ["eyes-closed"], analysisSource: "proxy", thumbnailURL: svgThumbnail("B0001731", ["#5c665e", "#23262c"]) },
    { id: "demo-4", name: "B0001731", ext: "HEIC", qualityScore: 79, width: 4096, height: 3072, tags: ["待复核", "AI配对待确认"], qualityFlags: ["overexposed"], metrics: { clippedHigh: .083 }, thumbnailURL: svgThumbnail("B0001731 HEIC", ["#b99b74", "#4a5964"]) },
  ];
  state.items = base;
  state.groups = [{ groupId: "phash-0001", size: 2, representativeId: "demo-1", items: base.slice(0, 2) }];
  state.focusedId = "demo-1";
  setView("review");
  setServiceState("ready", "界面演示数据");
  setStatus("演示模式：中文结论、相似组、RAW/JPG 配对和审阅状态均可预览；写入按钮已停用。", "success");
  render();
}

bindEvents();
setMode(state.mode);

if (eagleApi) {
  checkService();
  refreshTasks();
  setInterval(checkService, 5000);
  setInterval(refreshTasks, 3000);
  eagleApi.onPluginCreate(loadSelection);
} else if (demoMode) loadDemo();
else {
  setServiceState("offline", "未检测到 Eagle 环境");
  setStatus("请从 Eagle 的插件菜单打开本窗口；本地预览可在地址后加 ?demo=1。", "error");
}
