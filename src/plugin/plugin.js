import {
  REVIEW_STATES,
  buildReviewSections,
  matchesReviewFilter,
  summarize,
} from "./review-model.js";
import { runBoundedQueue } from "./task-queue.js";
import { createBatchItemReader, createProgressSummary } from "./batch-items.js";
import { registeredThumbnailIds } from "./thumbnail-ownership.js";
import { confirmSelectedRestore, refreshNativeThumbnail } from "./restore-selection.js";
import { restoreBackupThumbnail } from "./fast-restore.js";
import { reviewPage } from "./review-page.js";
import { planCaptureReview, applyReviewUnit } from "./capture-review.js";
import { buildCaptureIndex } from "./capture-units.js";
import { claimTaskExecution } from "./task-execution.js";
import { runPriorityReview } from "./priority-review.js";
import { taskLabels } from "./task-labels.js";
import { taskHistoryPage } from "./task-history.js";
import { planCaptureAnalysis, materializeCaptureAnalysis, overlayCachedAnalysis, readCaptureAnalysisContext } from "./capture-analysis.js";
import { APP_VERSION, serviceCompatibility } from "./runtime-contract.js";
import { inspectService } from "./service-status.js";
import { taskRequestPath } from "./task-request.js";
import { compareUnits, comparePair } from "./compare-review.js";
import { buildTaskReport, taskExceptionsCsv } from "./task-report.js";
import { PlanDraftStore, submitDurablePlan } from "./plan-drafts.js";

const SERVICE_URL = "http://127.0.0.1:43125";
const PLUGIN_VERSION = APP_VERSION;
const MODE_KEY = "eagle-culling-preview-mode";
const CONFIG_KEY = "eagle-culling-queue-config";
let reviewPlanning = false;
let manualControlGeneration = 0;
let historyPage = 0;
let reloadRequested = false;
let serviceReady = false;
let serviceObservation = null;
let serviceCheckPromise = null;
let comparison = null;
let comparisonSignature = null;
let planUploading = false;
const planDrafts = new PlanDraftStore();
let manifestCheckedFor = null;
let manualTaskSelection = false;
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
  restoreSelected: document.querySelector("#restore-selected"),
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
  taskCancel: document.querySelector("#task-cancel"),
  taskRecover: document.querySelector("#task-recover"),
  taskReportJson: document.querySelector("#task-report-json"),
  taskReportCsv: document.querySelector("#task-report-csv"),
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
  reviewPrev: document.querySelector("#review-prev"),
  reviewNext: document.querySelector("#review-next"),
  reviewPage: document.querySelector("#review-page"),
  summary: {
    total: document.querySelector("#summary-total"),
    selected: document.querySelector("#summary-selected"),
    candidate: document.querySelector("#summary-candidate"),
    rejected: document.querySelector("#summary-rejected"),
    issues: document.querySelector("#summary-issues"),
  },
};

const state = { items: [], groups: [], liveItems: new Map(), filter: "all", page: 0, focusedId: null, tasks: [], activeTask: null, running: false, paused: false, cancelled: false, taskStartedAt: 0, taskInitialCompleted: 0 };

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
  elements.restoreSelected.disabled = isBusy || !eagleApi;
  // Display preferences remain usable during analysis and while offline.
  elements.modeNative.disabled = false;
  elements.modeBadge.disabled = false;
  elements.taskResume.disabled = isBusy || !["paused","pending"].includes(state.activeTask?.status);
  elements.taskRetry.disabled = isBusy || !["failed","paused","pending"].includes(state.activeTask?.status) || !(state.activeTask?.summary?.failed > 0);
}

function setView(view) {
  elements.panels.forEach((panel) => { panel.hidden = panel.id !== `view-${view}`; });
  elements.views.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
}

function setOverlayVisibility(visible) {
  document.querySelector("#show-review-overlays").checked = visible;
  document.body.classList.toggle("hide-review-overlays", !visible);
  localStorage.setItem("eagle-culling-review-overlays", String(visible));
  elements.modeNative.classList.toggle("is-active", !visible);
  elements.modeBadge.classList.toggle("is-active", visible);
  elements.modeState.textContent = `插件角标：${visible ? "显示" : "隐藏"}。仅改变插件界面，不修改 Eagle 缩略图；网格旧角标需单独恢复。`;
}

function manifestEntries(manifest) {
  const raw = manifest?.items || manifest?.entries || [];
  if (Array.isArray(raw)) return raw.map((entry) => [entry.id || entry.itemId || entry.badgeKey, entry]).filter(([id]) => id);
  return Object.entries(raw);
}

async function serviceRequest(pathname, options = {}) {
  const response = await fetch(`${SERVICE_URL}${taskRequestPath(pathname, options)}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {statusCode:response.status});
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
  const score = Number.isFinite(record.qualityScore) ? `${Math.round(record.qualityScore)} ${record.qualityMethod === "heuristic-preview" ? "粗排参考分" : ["proxy", "paired-proxy"].includes(record.analysisSource) ? "代理分" : "分"}${record.analysisStale ? "（历史结果）" : ""}` : "未评分";
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
    `<button class="decision-button${record.state === key ? " is-current" : ""}" type="button" data-action="${key}" data-id="${escapeHtml(record.id)}"${demoMode || reviewPlanning || (state.running && state.activeTask?.taskType !== "analyze-selection") ? " disabled" : ""}>${actionLabels[key]}</button>`
  )).join("");
  return `
    <article class="item-row${state.focusedId === record.id ? " is-focused" : ""}" data-record-id="${escapeHtml(record.id)}" tabindex="0">
      <button class="thumbnail-button" type="button" data-action="locate" data-id="${escapeHtml(record.id)}" aria-label="在 Eagle 中定位 ${escapeHtml(record.name)}">${thumbnailMarkup}<span class="review-overlay state-badge" data-state="${record.state}">${escapeHtml(record.stateLabel)}</span></button>
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
        ${record.groupSize > 1 ? `<button class="locate-button" type="button" data-action="group-best" data-id="${escapeHtml(record.id)}"${demoMode || reviewPlanning || (state.running && state.activeTask?.taskType !== "analyze-selection") ? " disabled" : ""}>设为组内首选（成对留存）</button>` : ""}
        ${record.groupSize > 1 ? `<button class="locate-button" type="button" data-action="compare" data-id="${escapeHtml(record.id)}">并排比较同场景</button>` : ""}
        <button class="locate-button" type="button" data-action="locate" data-id="${escapeHtml(record.id)}">在 Eagle 中定位</button>
      </div>
    </article>`;
}

function render() {
  renderComparison();
  const records = allRecords();
  const totals = summarize(records);
  Object.entries(totals).forEach(([key, value]) => { elements.summary[key].textContent = String(value); });
  const page = reviewPage(visibleSections(), state.page);
  state.page = page.page;
  const sections = page.sections;
  const visibleCount = page.total;
  elements.reviewPrev.disabled = page.page === 0;
  elements.reviewNext.disabled = page.page >= page.pages - 1;
  elements.reviewPage.textContent = `${page.page + 1} / ${page.pages} 页 · 共 ${page.total} 张（总张数不限）`;
  elements.empty.hidden = visibleCount > 0;
  elements.list.hidden = visibleCount === 0;
  if (visibleCount === 0) {
    elements.empty.querySelector("h2").textContent = records.length ? "没有符合条件的照片" : "请先在 Eagle 中选择照片";
    elements.empty.querySelector("p").textContent = records.length ? "切换状态筛选或清空搜索词后再看。" : "选择需要处理的照片，任务队列会自动分配并发，无需手动分批。";
    elements.list.innerHTML = "";
    return;
  }
  elements.list.innerHTML = sections.map((section) => `
    <section class="review-group" aria-labelledby="heading-${escapeHtml(section.id)}">
      <div class="group-heading"><h2 id="heading-${escapeHtml(section.id)}">${escapeHtml(section.title)}</h2><p>${escapeHtml(section.note)}</p></div>
      <div class="group-items">${section.records.map(renderRecord).join("")}</div>
    </section>`).join("");
}

function openComparison(id) {
  const section = buildReviewSections(state.items,state.groups).find(section=>section.records.some(record=>record.id===id));
  const units = compareUnits(section?.records || []);
  if (units.length < 2 || section?.id === "other") return setStatus("该组没有两个可比较的拍摄单元；配对格式不算两次拍摄。");
  const preferred = units.find(unit=>unit.records.some(record=>record.id===id));
  comparison = {groupId:section.id,leftId:preferred?.id,libraryPath:eagleApi?.library?.path || null};
  comparisonSignature = null;
  renderComparison();
  document.querySelector("#compare-dialog").showModal();
}

function renderComparison() {
  if (!comparison) return;
  const dialog = document.querySelector("#compare-dialog");
  if (comparison.libraryPath !== (eagleApi?.library?.path || null)) { dialog.close();comparison=null;return; }
  const section = buildReviewSections(state.items,state.groups).find(section=>section.id===comparison.groupId);
  const units = compareUnits(section?.records || []);
  if (units.length < 2) { dialog.close();comparison=null;return; }
  const pair = comparePair(units,comparison);
  comparison.leftId=pair.left.id;comparison.rightId=pair.right.id;
  const disabled = demoMode || reviewPlanning || (state.running && state.activeTask?.taskType !== "analyze-selection");
  const signature = JSON.stringify([section.title,comparison,disabled,units.map(unit=>[unit.id,unit.record.id,unit.record.thumbnailURL,unit.record.state,unit.record.qualityScore,unit.record.analysisStale])]);
  if (signature === comparisonSignature) return;
  comparisonSignature = signature;
  document.querySelector("#compare-title").textContent=`${section.title} · ${units.length} 次拍摄`;
  document.querySelector("#compare-panels").innerHTML = ["left","right"].map(side=>{
    const unit=pair[side],record=unit.record,other=pair[side==="left" ? "right" : "left"];
    const options=units.map(entry=>`<option value="${escapeHtml(entry.id)}"${entry.id===unit.id ? " selected" : ""}${entry.id===other.id ? " disabled" : ""}>${escapeHtml(entry.record.name)} · ${escapeHtml(entry.record.stateLabel)}</option>`).join("");
    const score=Number.isFinite(record.qualityScore) ? `${record.qualityScore} 粗排参考分${record.analysisStale ? "（历史结果）" : ""}` : "未评分";
    const image=record.thumbnailURL ? `<img src="${escapeHtml(record.thumbnailURL)}" alt="${escapeHtml(record.name)} 的现有预览">` : `<p class="muted">暂无可用缩略图，请在 Eagle 中定位检查。</p>`;
    return `<article class="compare-panel"><label>${side==="left" ? "左侧" : "右侧"}<select data-compare-side="${side}" aria-label="${side==="left" ? "左侧" : "右侧"}比较照片">${options}</select></label><div class="compare-image">${image}<span class="review-overlay state-badge" data-state="${record.state}">${escapeHtml(record.stateLabel)}</span></div><p>${escapeHtml(record.name)} · ${escapeHtml((record.ext || "").toUpperCase())} · ${escapeHtml(score)}</p><p class="muted">${unit.records.length > 1 ? `同次拍摄 ${unit.records.length} 个配对文件，优先显示成片` : "当前仅展示一个格式"}</p><div class="choice-row"><button class="button button-secondary" data-compare-best="${escapeHtml(record.id)}"${disabled ? " disabled" : ""}>设为组内首选</button><button class="locate-button" data-compare-locate="${escapeHtml(record.id)}">在 Eagle 中定位</button></div></article>`;
  }).join("");
}

function renderTasks() {
  renderTaskHistory();
  const task = state.activeTask || state.tasks[0];
  elements.taskReportJson.disabled = !task;
  elements.taskReportCsv.disabled = !task;
  if (!task) {
    elements.taskCurrent.textContent = "暂无运行中的任务";
    elements.taskProgressBar.style.width = "0%";
    elements.taskCompleted.textContent = "0 / 0";
    return;
  }
  const summary = task.summary || {};
  const total = Number(summary.total || task.items?.length || 0);
  const completed = Number(summary.succeeded || 0) + Number(summary.skipped || 0) + Number(summary.failed || 0);
  const sessionCompleted = Math.max(0, completed - state.taskInitialCompleted);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const labels = taskLabels(task);
  elements.taskCurrent.textContent = `${labels.type} · ${labels.status}`;
  elements.taskRecover.hidden = !task.execution || state.running;
  elements.taskRecover.disabled = !task.execution || Date.now() - Date.parse(task.execution.heartbeatAt) < 30000;
  elements.taskProgressBar.style.width = `${percent}%`;
  elements.taskCompleted.textContent = `${completed} / ${total}`;
  elements.taskSuccess.textContent = `成功 ${summary.succeeded || 0}`;
  elements.taskSkipped.textContent = `跳过 ${summary.skipped || 0}`;
  elements.taskFailed.textContent = `失败 ${summary.failed || 0}`;
  elements.taskSpeed.textContent = state.running && state.taskStartedAt && sessionCompleted ? `${(sessionCompleted / Math.max(1, (Date.now() - state.taskStartedAt) / 1000)).toFixed(1)} 项/秒` : "—";
  elements.taskEta.textContent = state.running && sessionCompleted && total > completed && state.taskStartedAt ? `剩余约 ${Math.ceil(((Date.now() - state.taskStartedAt) / sessionCompleted) * (total - completed) / 1000)} 秒` : "—";
  elements.taskResume.disabled = state.running || !["paused","pending"].includes(task.status);
  elements.taskRetry.disabled = state.running || !["failed","paused","pending"].includes(task.status) || !(summary.failed > 0);
  elements.taskError.textContent = task.activationPending && task.status === "paused" ? "计划已保存，尚未开始写入 Eagle。在任务原资源库点击“继续”可确认启动。" : task.execution && !state.running ? `其他窗口持有执行权；最近心跳：${new Date(task.execution.heartbeatAt).toLocaleTimeString()}。失联不会自动抢占。` : task.error || (task.errors?.length ? task.errors.at(-1).error : `最近更新：${new Date(task.updatedAt).toLocaleTimeString()}`);
}

function renderTaskHistory() {
  const result=taskHistoryPage(state.tasks,{page:historyPage,query:document.querySelector("#task-history-search").value});
  historyPage=result.page;
  document.querySelector("#task-history-prev").disabled=result.page === 0;
  document.querySelector("#task-history-next").disabled=result.page >= result.pages-1;
  document.querySelector("#task-history-page").textContent=`${result.page+1} / ${result.pages} 页 · 共 ${result.total} 个任务`;
  elements.taskHistory.innerHTML = result.items.map((entry) => { const labels=taskLabels(entry);return `<div class="task-history-row"><button type="button" class="locate-button" data-task-id="${escapeHtml(entry.taskId)}">${escapeHtml(labels.type)} · ${escapeHtml(entry.taskId)}</button><span>${entry.libraryPath === eagleApi?.library?.path ? "当前库" : "其他库"} · ${escapeHtml(labels.status)} · ${entry.summary?.succeeded || 0}/${entry.summary?.total || entry.items?.length || 0}</span></div>`; }).join("");
}

async function checkService() {
  if (serviceCheckPromise) return serviceCheckPromise;
  serviceCheckPromise = refreshServiceState().finally(() => { serviceCheckPromise = null; });
  return serviceCheckPromise;
}

async function refreshServiceState() {
  try {
    serviceObservation = await inspectService(SERVICE_URL);
    serviceReady = serviceObservation.ready;
    elements.serviceVersion.textContent = serviceObservation.versionText;
    elements.serviceError.textContent = serviceObservation.message;
    setServiceState(serviceObservation.state, serviceObservation.title);
    document.querySelector("#service-upgrade-help").hidden = serviceReady;
    const resourceState = document.querySelector("#resource-state");
    if (serviceReady) try {
      const diagnostics = await serviceRequest("/diagnostics");
      if (diagnostics.image) resourceState.textContent = `图片解码 ${diagnostics.image.active}/${diagnostics.image.concurrency}，等待 ${diagnostics.image.pending}；每图 ${diagnostics.image.nativeThreads} 个本地线程。人脸模型 ${diagnostics.face.modelProcesses}/${diagnostics.face.concurrency}，等待 ${diagnostics.face.pending}。服务 RSS ${Math.round(diagnostics.memory.rss / 1024 ** 2)} MiB；系统可用 ${(diagnostics.image.freeMemoryBytes / 1024 ** 3).toFixed(1)} GiB${diagnostics.image.memoryCapacity === 0 ? "；内存压力下等待，不再启动解码" : ""}。`;
    } catch { resourceState.textContent = "资源指标暂不可用；任务状态另行显示。"; }
    else resourceState.textContent = "服务尚未就绪，暂不读取新版资源指标；API 并发不代表同时加载的模型数。";
    const libraryKey = eagleApi?.library?.path || "unknown";
    if (manifestCheckedFor !== libraryKey) try {
      const manifest = await serviceRequest("/badge-manifest");
      const count = manifestEntries(manifest).filter(([, entry]) => entry && entry.outputPath && !entry.skipped).length;
      elements.migrationNote.textContent = count ? `发现旧版角标清单（${count} 项）。迁移不会自动恢复或删除，可在任务中选择模式。` : "未发现旧版角标清单，新的任务会自动登记归属。";
      manifestCheckedFor = libraryKey;
    } catch {
      elements.migrationNote.textContent = "暂无旧版角标清单；服务恢复后会自动检查。";
    }
  } catch (error) {
    serviceReady = false;
    elements.serviceVersion.textContent = "未连接";
    elements.serviceError.textContent = `服务检查异常：${error.message}。请导出诊断；不会自动启动或重启服务。`;
    setServiceState("unhealthy", "服务检查异常");
  }
}

async function refreshTasks() {
  if (!eagleApi) return;
  try {
    const payload = await serviceRequest("/tasks");
    state.tasks = payload.tasks || [];
    if (manualTaskSelection && state.activeTask && !state.running) {
      const selected = state.tasks.find((task) => task.taskId === state.activeTask.taskId);
      if (selected) state.activeTask = { ...state.activeTask, ...selected };
      renderTasks();
      return;
    }
    const active = state.tasks.find((task) => task.libraryPath === eagleApi.library?.path && ["pending", "running", "paused"].includes(task.status));
    if (active && !state.running) {
      state.activeTask = { ...(state.activeTask?.taskId === active.taskId ? state.activeTask : {}), ...active };
      if (!reviewPlanning && !planUploading && serviceReady && ["pending", "running"].includes(active.status) && !active.execution) {
        state.activeTask = await serviceRequest(`/tasks/${active.taskId}`);
        resumeStoredTask(state.activeTask);
      }
    }
    renderTasks();
  } catch { /* status is already represented by the service indicator */ }
}

function resumeStoredTask(task) {
  if (state.running || !eagleApi) return;
  state.runPromise = (async () => {
  manualTaskSelection = false;
  state.running = true;
  state.paused = false;
  state.cancelled = false;
  setBusy(true);
  state.taskStartedAt = Date.now();
  state.taskInitialCompleted = (task.summary?.succeeded || 0) + (task.summary?.skipped || 0) + (task.summary?.failed || 0);
  try {
    if (task.taskType === "analyze-selection" && !state.paused && !state.cancelled) {
      const readItem = createBatchItemReader(eagleApi.item);
      const allItems = [];
      const ids = [...new Set(task.items.flatMap((entry) => entry.result?.analysisPlan?.members?.map((member) => member.id) || [entry.id]))];
      const readIds = [...new Set([...ids, ...task.items.map((entry) => entry.result?.analysisPlan?.sourceId).filter(Boolean)])];
      for (let offset = 0; offset < readIds.length; offset += 256) {
        allItems.push(...await Promise.all(readIds.slice(offset, offset + 256).map((id) => readItem(id))));
      }
      const saved = new Map(task.items.flatMap((entry) => (entry.result?.captureResults || (entry.result?.phash ? [entry.result] : [])).map((item) => [item.id, item])));
      const currentById = new Map(allItems.filter(Boolean).map((item) => [item.id, snapshotItem(item)]));
      state.items = ids.map((id) => currentById.get(id)).filter(Boolean).map((item) => overlayCachedAnalysis(item, saved.get(item.id), currentById.get(saved.get(item.id)?.analysisSourceId)));
      render();
    }
    setStatus(`正在从断点继续任务：${task.taskId}…`, "neutral");
    await runTask(task);
  } catch (error) {
    state.running = false;
    setBusy(false);
    setStatus(`断点恢复失败：${error.message}`, "error");
  }
  })();
  return state.runPromise;
}

async function loadSelection() {
  if (!eagleApi) return;
  setBusy(true);
  setStatus("正在读取 Eagle 当前选择…");
  try {
    const selected = await eagleApi.item.getSelected();
    state.liveItems = new Map(selected.map((item) => [item.id, item]));
    state.items = selected.map(snapshotItem);
    state.page = 0;
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
  const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "3fr", "arw", "dng", "cr2", "cr3", "nef", "raf", "orf", "rw2", "tif", "tiff"]);
  return items.filter((item) => imageExtensions.has(String(item.ext || "").toLowerCase().replace(/^\./, "")) && (item.thumbnailPath || item.filePath)).map((item) => ({ id: item.id, modifiedAt: item.modifiedAt || null, status: "pending", attempts: 0 }));
}

function queueConfig() {
  const concurrency = Number(elements.concurrency.value);
  const delayMs = Number(elements.delay.value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("并发数必须为正整数");
  return { concurrency, delayMs, maxAttempts: 3, includeEmbeddings:document.querySelector("#semantic-enabled").checked, highQualityPreviews:document.querySelector("#high-quality-previews").checked };
}

async function configureActiveTask() {
  return serviceRequest(`/tasks/${state.activeTask.taskId}/configure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(queueConfig()) });
}

async function createTask(taskType, items, plannedRecords = null, context = {}) {
  if (state.running || planUploading) throw new Error("已有任务运行或上传，请先等待完成");
  const libraryPath = context.libraryPath || eagleApi.library?.path;
  if (!libraryPath) throw new Error("无法确认当前资源库路径，为防止跨库写入，未创建任务");
  const guard = () => {
    if (eagleApi.library?.path !== libraryPath) throw new Error("资源库已切换，旧计划不会写入新资源库");
    if (context.stillAllowed && !context.stillAllowed()) throw new Error("任务控制已变化，未开始写回");
  };
  let task;
  // Reserve creation before the first network await, not only during upload.
  planUploading = true;
  try {
    guard();
    const version = await serviceRequest("/version");
    guard();
    const compatibility = serviceCompatibility(version);
    if (!compatibility.compatible) throw new Error(compatibility.message);
    const records = plannedRecords || taskItemsFromEagle(items);
    if (!records.length) throw new Error("当前没有可处理的图片");
    const history = await serviceRequest("/tasks");
    guard();
    if ((history.tasks || []).some((task) => task.libraryPath === libraryPath && task.status === "running")) throw new Error("当前资源库已有运行任务（可能来自另一窗口），请先暂停或等待完成");
    task = await submitDurablePlan(serviceRequest, { taskType, status: "paused", activationPending:true, requiresExecution: true, libraryPath, manifestVersion: PLUGIN_VERSION, config: queueConfig(), items: records }, {
      store:planDrafts, onProgress: (done, total) => setStatus(`正在上传任务计划：${done}/${total}（尚未写入 Eagle）`),
    });
    await refreshUploadDrafts();
    guard();
  } catch (error) {
    if (task?.taskId) {
      // The uploaded plan belongs to the original library. Never reinterpret
      // it as a new-library plan or silently start it after control changed.
      manualTaskSelection = true;
      try { state.activeTask = await serviceRequest(`/tasks/${task.taskId}/pause`,{method:"POST"}); }
      catch (pauseError) {
        state.activeTask = task;
        error.message += `；计划 ${task.taskId} 已上传，但无法确认暂停：${pauseError.message}。请在原资源库任务页检查；本窗口不会自动执行。`;
      }
    }
    throw error;
  } finally { planUploading = false; }
  state.activeTask = task;
  manualTaskSelection = false;
  state.taskStartedAt = Date.now();
  state.taskInitialCompleted = 0;
  state.running = true;
  state.paused = false;
  state.cancelled = false;
  renderTasks();
  state.runPromise = runTask(task).catch((error) => setStatus(`任务失败：${error.message}`, "error"));
}

async function refreshUploadDrafts() {
  const container = document.querySelector("#upload-drafts");
  try {
    const drafts = (await planDrafts.list()).filter(draft => draft.input.libraryPath === eagleApi?.library?.path);
    container.innerHTML = drafts.map(draft => `<div class="task-history-row"><span>上传未完成 · ${escapeHtml(taskLabels(draft.input).type)} · ${draft.input.items.length} 项</span><button type="button" class="button button-secondary" data-resume-upload="${escapeHtml(draft.taskId)}">继续上传计划</button></div>`).join("");
  } catch (error) { container.textContent = `本地续传存储不可用：${error.message}。大计划不会在未保存断点时提交。`; }
}

async function runTask(task) {
  let execution;
  const analysisAbort = new AbortController();
  state.analysisAbort = analysisAbort;
  try {
    if (!["review-units", "analyze-selection", "restore-thumbnails", "restore-thumbnail-backups", "badge-thumbnails-selection", "badge-thumbnails-library"].includes(task.taskType)) throw new Error("未知任务类型，未执行任何写回");
    if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库不匹配：请打开任务原资源库后再继续");
    const version = await serviceRequest("/version");
    const compatibility = serviceCompatibility(version);
    if (!compatibility.compatible) throw new Error(compatibility.message);
    if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，未激活任务");
    execution = await claimTaskExecution({ request: serviceRequest, task, onControl: (status) => {
      if (status === "paused") state.paused = true;
      if (status === "cancelled") state.cancelled = true;
      if (["paused", "cancelled"].includes(status)) analysisAbort.abort(Object.assign(new Error("分析已暂停或取消"),{interrupted:true}));
    } });
    task.activationPending = false;
    task.status = "running";
    if (state.activeTask?.taskId === task.taskId) state.activeTask = {...state.activeTask,activationPending:false,status:"running"};
    const ownedRequest = (pathname, options = {}) => serviceRequest(pathname, { ...options, headers: { ...options.headers, "x-task-owner": execution.ownerId } });
    const byId = new Map((task.items || []).map((entry) => [entry.id, entry]));
    const readItem = createBatchItemReader(eagleApi.item);
    const progressSummary = createProgressSummary(task.items || []);
    let lastRenderAt = 0;
    const uncertainBackupIds = new Set();
    const badgeHashes = new Map();
    if (task.taskType === "restore-thumbnail-backups") {
      const history = await serviceRequest("/tasks?includeItems=true");
      for (const previous of (history.tasks || []).filter((entry) => entry.libraryPath === task.libraryPath).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        for (const entry of previous.items || []) {
          if (entry.status === "succeeded" && previous.taskType.startsWith("badge-thumbnails")) badgeHashes.set(entry.id, entry.badgeSha256);
          else if (entry.status === "succeeded" && previous.taskType === "restore-thumbnails") badgeHashes.delete(entry.id);
        }
      }
    }
    if (task.taskType.startsWith("badge-thumbnails")) {
      const version = await serviceRequest("/version");
      if (!version.capabilities?.includes("thumbnail-backup-v1")) throw new Error("本地服务需要更新，暂停任务后重启服务以启用缩略图备份");
      const history = await serviceRequest("/tasks?includeItems=true");
      for (const id of registeredThumbnailIds(history.tasks || [], task.libraryPath)) uncertainBackupIds.add(id);
      // Legacy manifests can only flag uncertainty, never prove a clean thumbnail.
      const legacy = await serviceRequest("/badge-manifest").catch(() => null);
      for (const [id, entry] of manifestEntries(legacy || {})) {
        if (entry?.outputPath && !entry.skipped) uncertainBackupIds.add(id);
      }
      const events = new Map();
      for (const previous of (history.tasks || []).filter((entry) => entry.libraryPath === task.libraryPath).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        for (const entry of previous.items || []) {
          if (entry.status === "succeeded" && (previous.taskType.startsWith("badge-thumbnails") || previous.taskType.startsWith("restore-"))) events.set(entry.id, previous.taskType);
        }
      }
      for (const [id, type] of events) if (type === "restore-thumbnails") uncertainBackupIds.delete(id);
    }
    let sinceCheckpoint = 0;
    const pendingPersistence = new Set();
    let checkpointChain = Promise.resolve();
    const flush = () => {
      const updates = [...pendingPersistence].map((id) => ({ itemId: id, ...byId.get(id) }));
      pendingPersistence.clear();
      sinceCheckpoint = 0;
      if (!updates.length) return checkpointChain;
      checkpointChain = checkpointChain.then(() => ownedRequest(`/tasks/${task.taskId}/checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: updates }) }));
      return checkpointChain;
    };
    const result = await runBoundedQueue({
      items: task.items || [],
      concurrency: task.config?.concurrency || 8,
      delayMs: task.config?.delayMs ?? 0,
      maxAttempts: task.config?.maxAttempts || 3,
      shouldSkip: (entry) => byId.get(entry.id)?.status === "succeeded" || byId.get(entry.id)?.status === "skipped",
      shouldPause: () => state.paused,
      shouldCancel: () => state.cancelled,
      process: async (entry, attempt) => {
        execution.guard();
        if (task.libraryPath !== eagleApi.library?.path) throw new Error("运行期间切换了资源库，停止写回");
        if (task.taskType === "review-units") {
          return applyReviewUnit(eagleApi, entry, {
            libraryPath: task.libraryPath,
            beforeWrite: () => execution.guard(),
            checkpoint: (saved) => ownedRequest(`/tasks/${task.taskId}/checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ itemId: saved.id, ...saved }] }) }),
            onApplied: (item) => {
              const current = state.items.find((snapshot) => snapshot.id === item.id);
              if (current) current.tags = [...item.tags];
              state.liveItems.set(item.id, item);
            },
          });
        }
        const item = await readItem(entry.id);
        if (task.libraryPath !== eagleApi.library?.path) throw new Error("运行期间切换了资源库，停止写回");
        if (!item) return { status: "skipped", error: "Eagle 项目不存在" };
        if (entry.modifiedAt != null && item.modifiedAt !== entry.modifiedAt) return { status: "skipped", error: "modifiedAt 已变化，保留人工修改" };
        if (task.taskType === "restore-thumbnails") {
          execution.guard();
          await refreshNativeThumbnail(item);
          return;
        }
        if (task.taskType === "restore-thumbnail-backups") {
          const payload = await serviceRequest("/thumbnail-backup/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ libraryPath: task.libraryPath, itemId: item.id, sourcePath: item.thumbnailPath, badgeSha256: badgeHashes.get(item.id) }) });
          if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，停止写回");
          if (!payload.backup) return { status: "skipped", error: payload.reason || "没有干净备份，请明确选择重建原生预览" };
          execution.guard();
          return restoreBackupThumbnail(item, payload.backup);
        }
        if (task.taskType === "analyze-selection") {
          const plan = entry.result?.analysisPlan || { sourceId: item.id, sourceModifiedAt: item.modifiedAt ?? null, members: [{id:item.id, modifiedAt:item.modifiedAt ?? null}] };
          const before = await readCaptureAnalysisContext(plan, readItem);
          if (before.error) return { status: "skipped", error: before.error };
          const source = before.source;
          execution.guard();
          if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，停止分析");
          const snapshot = snapshotItem(source);
          const analyzed = await serviceRequest("/analyze", { method: "POST", headers: { "content-type": "application/json" }, signal:analysisAbort.signal, body: JSON.stringify({ items: [{ ...snapshot, analysisPath: snapshot.thumbnailPath || snapshot.filePath }], includeFaces: true, includeEmbeddings:task.config?.includeEmbeddings === true, highQualityPreviews:task.config?.highQualityPreviews === true }) }).catch((error) => {
            if (analysisAbort.signal.aborted) throw Object.assign(new Error("分析已暂停或取消，项目保持待处理"),{interrupted:true});
            throw error;
          });
          if (!analyzed.items?.[0]) throw new Error("分析未返回照片结果");
          const after = await readCaptureAnalysisContext(plan, readItem);
          execution.guard();
          if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，丢弃迟到的分析结果");
          if (after.error) {
            for (const member of after.members.filter(Boolean)) {
              const current = state.items.find((snapshot) => snapshot.id === member.id);
              if (current) Object.assign(current, snapshotItem(member), {analysisStale:true, analysisStaleReasons:["item-modified"]});
            }
            return { status: "skipped", error: `分析期间项目发生变化，未应用结果：${after.error}` };
          }
          const captureResults = materializeCaptureAnalysis(analyzed.items[0], after.members.map(snapshotItem), source.id, plan);
          entry.result = { ...captureResults.find((result) => result.id === entry.id), analysisPlan: plan, captureResults };
          for (const result of captureResults) {
            const current = state.items.find((snapshot) => snapshot.id === result.id);
            if (current) Object.assign(current, result);
          }
          if (Date.now() - lastRenderAt >= 250) render();
          return;
        }
        const prepared = await serviceRequest("/thumbnail-backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ libraryPath: task.libraryPath, itemId: item.id, sourcePath: item.thumbnailPath, allowCapture: !uncertainBackupIds.has(item.id) }) });
        const payload = await serviceRequest("/badge-thumbnail", { method: "POST", headers: { "content-type": "application/json" }, signal:analysisAbort.signal, body: JSON.stringify({ badgeKey: item.id, outputPath: `${prepared.backup.outputPath}.badge.png`, sourcePath: prepared.backup.outputPath, tags: item.tags || [] }) }).catch((error) => {
          if (analysisAbort.signal.aborted) throw Object.assign(new Error("生成角标已暂停或取消，未写回 Eagle"),{interrupted:true});
          throw error;
        });
        if (payload.skipped) return { status: "skipped", error: "无可用 AI 标签" };
        if (typeof item.setCustomThumbnail !== "function") throw new Error("当前 Eagle API 不支持 setCustomThumbnail");
        if (payload.outputPath && !payload.skipped && typeof item.setCustomThumbnail === "function") {
          if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，停止写回");
          execution.guard();
          const applied = await item.setCustomThumbnail(payload.outputPath);
          if (applied === false) throw new Error("Eagle 拒绝写入角标缩略图");
          entry.outputPath = payload.outputPath;
          // Fingerprint the actual Eagle thumbnail, which Eagle may re-encode.
          const fingerprint = await serviceRequest("/thumbnail-fingerprint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: item.thumbnailPath }) }).catch(() => null);
          entry.badgeSha256 = fingerprint?.sha256 || null;
        }
        entry.attempts = attempt;
      },
      onProgress: async (progress) => {
        const patch = { status: progress.status, attempts: progress.attempts, error: progress.error || null, outputPath: progress.item.outputPath || null, badgeSha256: progress.item.badgeSha256 || null };
        Object.assign(byId.get(progress.item.id) || {}, patch);
        pendingPersistence.add(progress.item.id);
        sinceCheckpoint += 1;
        if (progress.status === "failed" || sinceCheckpoint >= 25) {
          await flush();
        }
        progressSummary.update(progress.item.id, progress.status);
        state.activeTask = { ...state.activeTask, items: task.items, summary: { ...progressSummary.summary } };
        if (Date.now() - lastRenderAt >= 250) {
          lastRenderAt = Date.now();
          renderTasks();
        }
      },
    });
    await flush();
    if (task.taskType === "analyze-selection") {
      const clustered = await serviceRequest("/cluster", { method: "POST", headers: { "content-type": "application/json" }, signal:analysisAbort.signal, body: JSON.stringify({ taskId: task.taskId, includeEmbeddings:task.config?.includeEmbeddings === true }) });
      execution.guard();
      if (task.libraryPath !== eagleApi.library?.path) throw new Error("资源库已切换，未应用场景分组");
      state.groups = clustered.groups || [];
      if (clustered.semantic) setStatus(`DINO 场景分组：${clustered.semantic.available}/${clustered.semantic.total} 个单元有有效向量；其余仅用 pHash。场景相似不代表重复，首选需人工确认。`);
      render();
    }
    let status = state.cancelled ? "cancelled" : state.paused ? "paused" : result.failed ? "failed" : "succeeded";
    if (status === "succeeded") await ownedRequest(`/tasks/${task.taskId}/complete`, { method: "POST" });
    else if (status === "paused") await serviceRequest(`/tasks/${task.taskId}/pause`, { method: "POST" });
    else if (status === "cancelled") await serviceRequest(`/tasks/${task.taskId}/cancel`, { method: "POST" });
    else await ownedRequest(`/tasks/${task.taskId}/fail`, { method: "POST" });
    state.activeTask = await serviceRequest(`/tasks/${task.taskId}`);
    status = state.activeTask.status;
    if (task.taskType === "analyze-selection" && status === "succeeded" && elements.views.querySelector('[data-view="tasks"]').classList.contains("is-active")) setView("review");
    if (task.taskType === "review-units") render();
    setStatus(status === "succeeded" ? `任务完成：成功 ${state.activeTask.summary.succeeded}，跳过 ${state.activeTask.summary.skipped}。` : `任务状态：${taskLabels(state.activeTask).status}；失败项可单独重试，暂停任务可继续。`, status === "succeeded" ? "success" : "neutral");
  } catch (error) {
    if (execution && task?.taskId && !state.paused && !state.cancelled) await serviceRequest(`/tasks/${task.taskId}/fail`, { method: "POST", headers: { "x-task-owner": execution.ownerId } }).catch(() => {});
    setStatus(`任务失败：${error.message}`, "error");
  } finally {
    if (state.analysisAbort === analysisAbort) state.analysisAbort = null;
    if (execution) try {
      await execution.close();
      if (state.activeTask?.taskId === task.taskId) state.activeTask.execution = null;
    } catch (error) { setStatus(`任务结束但执行权未释放：${error.message}；不会自动抢占`, "error"); }
    state.running = false;
    setBusy(false);
    if (reloadRequested) location.reload();
    else if (execution) { await refreshTasks(); render(); }
  }
}

async function generateBadges() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getSelected();
    if (!selected.length) throw new Error("请先在 Eagle 中选择照片");
    if (!window.confirm(`将为所选 ${selected.length} 个项目逐项写入 Eagle 自定义缩略图，可能影响高清预览；这不是插件显示开关。日常分拣无需此操作。确认继续写入？`)) return setStatus("已取消网格角标写入；插件角标显示不受影响。");
    setView("tasks"); setBusy(true); await createTask("badge-thumbnails-selection", selected);
    setStatus(`已创建当前选择的角标任务（${selected.length} 项），可在任务页暂停或继续。`, "success");
  } catch (error) { setBusy(false); setStatus(`角标任务创建失败：${error.message}`, "error"); }
}

async function analyzeAsTask() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getSelected();
    if (!selected.length) throw new Error("请先在 Eagle 中选择照片");
    state.liveItems = new Map(selected.map((item) => [item.id, item]));
    state.items = selected.map(snapshotItem);
    render();
    const libraryPath = eagleApi.library?.path;
    const catalogue = typeof eagleApi.item.get === "function" ? await eagleApi.item.get({ fields: ["id", "name", "ext", "folders", "modifiedAt"] }) : await eagleApi.item.getAll();
    if (!libraryPath || eagleApi.library?.path !== libraryPath) throw new Error("无法确认分析目录资源库，未创建任务");
    const imageItems = selected.filter((item) => taskItemsFromEagle([item]).length);
    const records = planCaptureAnalysis(catalogue, imageItems);
    setView("tasks"); setBusy(true); await createTask("analyze-selection", [], records);
    setStatus(`已创建 AI 分析任务：${records.length} 次拍摄、${imageItems.length} 个文件；一对一配对仅计算一份预览。`, "success");
  } catch (error) { setBusy(false); setStatus(`分析任务创建失败：${error.message}`, "error"); }
}

async function generateAllBadges() {
  if (!eagleApi) return;
  try {
    const allItems = await eagleApi.item.getAll();
    if (!window.confirm(`将为全库 ${allItems.length} 个项目创建 Eagle 缩略图写入任务，可能影响高清预览；这不是即时显示开关。确认需要兼容网格角标并继续？`)) return setStatus("已取消全库网格角标写入；日常审阅不需要此任务。");
    setView("tasks"); setBusy(true); await createTask("badge-thumbnails-library", allItems);
    setStatus(`已创建全库角标任务（${allItems.length} 项），默认并发 ${elements.concurrency.value}。`, "success");
  } catch (error) { setBusy(false); setStatus(`全库任务创建失败：${error.message}`, "error"); }
}

async function restoreBadges() {
  if (!eagleApi) return;
  try {
    const selected = await eagleApi.item.getAll();
    const payload = await serviceRequest("/tasks?includeItems=true");
    const ownedIds = registeredThumbnailIds(payload.tasks || [], eagleApi.library?.path);
    const owned = selected.filter((item) => ownedIds.has(item.id));
    if (!owned.length) throw new Error("当前选择中没有本工具登记过的角标；为保护人工缩略图，未执行恢复");
    const version = await serviceRequest("/version");
    if (!version.capabilities?.includes("thumbnail-backup-v1")) throw new Error("请先更新本地服务以启用快速恢复");
    setView("tasks"); setBusy(true); await createTask("restore-thumbnail-backups", owned);
    setStatus(`已创建快速隐藏角标任务（${owned.length} 项），无备份项目跳过，不自动重建。`, "success");
  } catch (error) { setBusy(false); setStatus(`恢复任务创建失败：${error.message}`, "error"); }
}

async function restoreSelectedThumbnails() {
  if (!eagleApi || state.running) return;
  try {
    const selected = await confirmSelectedRestore(eagleApi, (message) => window.confirm(message));
    if (!selected.length) { setStatus("已取消恢复，未修改任何照片。"); return; }
    setView("tasks");
    setBusy(true);
    await createTask("restore-thumbnails", selected);
    setStatus(`已创建所选 ${selected.length} 张照片的原生缩略图恢复任务，支持暂停和失败重试。`, "success");
  } catch (error) {
    setBusy(false);
    setStatus(`所选照片恢复失败：${error.message}`, "error");
  }
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

async function applyReviewState(id, reviewState, chooseGroup = false) {
  if (!eagleApi) return;
  if (reviewPlanning) return;
  reviewPlanning = true;
  const generation = manualControlGeneration;
  render();
  const label = REVIEW_STATES[reviewState].label;
  try {
    if (state.running && state.activeTask?.taskType !== "analyze-selection") throw new Error("当前正在修改缩略图或标签，请先等待任务结束");
    const libraryPath = eagleApi.library?.path;
    if (!libraryPath) throw new Error("无法确认当前资源库，未写入标签");
    // Read only catalogue fields, not photo bytes. Query the whole library so
    // duplicate camera filenames outside the selection cannot cause false pairs.
    const catalogue = typeof eagleApi.item.get === "function"
      ? await eagleApi.item.get({ fields: ["id", "name", "ext", "folders", "tags", "modifiedAt"] })
      : await eagleApi.item.getAll();
    if (eagleApi.library?.path !== libraryPath) throw new Error("资源库已切换，未写入标签");
    const captures = buildCaptureIndex(catalogue);
    const unit = captures.get(id);
    const syncPairs = document.querySelector("#sync-pairs").checked;
    const chosenIds = syncPairs && unit?.status === "paired" ? unit.itemIds : [id];
    let decisions = [{ id, reviewState }];
    if (chooseGroup) {
      const chosen = allRecords().find((record) => record.id === id);
      if (!chosen?.groupId) throw new Error("该照片没有可审阅的相似组");
      decisions = allRecords().filter((record) => record.groupId === chosen.groupId).map((record) => ({ id: record.id, reviewState: chosenIds.includes(record.id) ? "selected" : "rejected" }));
    }
    const records = planCaptureReview(catalogue, decisions, { syncPairs });
    if (chooseGroup && !window.confirm(`将本张${syncPairs ? "及确认配对" : ""}设为精选，同组其余拍摄设为待复核。共 ${records.length} 个审阅单元、${records.flatMap(record => record.result.review.members).length} 个文件；不删除、不改星级。继续？`)) return;
    setStatus(`创建“${label}”审阅任务：${records.flatMap((record) => record.result.review.members).length} 个文件${unit?.status === "uncertain" ? "；同名配对有歧义，仅处理本张" : ""}。`);
    const background = state.running ? state.activeTask : null;
    const backgroundRun = state.runPromise;
    await runPriorityReview({
      background,
      stillAllowed: () => eagleApi.library?.path === libraryPath && manualControlGeneration === generation && !reloadRequested,
      pause: async task => {
        if (!backgroundRun) throw new Error("无法确认分析执行句柄，未开始审阅");
        await serviceRequest(`/tasks/${task.taskId}/pause`, {method:"POST"});
        state.paused = true;
        state.analysisAbort?.abort(Object.assign(new Error("人工审阅优先，分析从断点继续"),{interrupted:true}));
        setStatus("正在等待分析让出执行权，然后保存人工决定…");
      },
      drain: () => backgroundRun,
      getTask: taskId => serviceRequest(`/tasks/${taskId}`),
      runReview: async () => {
        await createTask("review-units", [], records, {
          libraryPath,
          stillAllowed: () => manualControlGeneration === generation && !reloadRequested,
        });
        const taskId = state.activeTask.taskId;
        await state.runPromise;
        const reviewed = await serviceRequest(`/tasks/${taskId}`);
        if (reviewed.status !== "succeeded" || reviewed.execution) throw new Error("人工审阅尚未完整保存，分析保持暂停；可在任务页重试");
      },
      resume: async task => {
        const resumed = await serviceRequest(`/tasks/${task.taskId}/resume`, {method:"POST"});
        state.activeTask = resumed;
        // Do not hold the review interaction open for the entire analysis run.
        resumeStoredTask(resumed).catch(error=>setStatus(`自动继续失败：${error.message}`,"error"));
      },
    });
  } catch (error) {
    setStatus(`写入失败：${error.message}`, "error");
  } finally {
    reviewPlanning = false;
    render();
  }
}

function focusRecord(id) {
  const index = visibleSections().flatMap((section) => section.records).findIndex((record) => record.id === id);
  if (index >= 0 && Math.floor(index / 80) !== state.page) {
    state.page = Math.floor(index / 80);
    render();
  }
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
  elements.reviewPrev.addEventListener("click", () => { state.page -= 1; render(); });
  elements.reviewNext.addEventListener("click", () => { state.page += 1; render(); });
  elements.views.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });
  elements.inspect.addEventListener("click", loadSelection);
  elements.analyze.addEventListener("click", analyzeAsTask);
  elements.badges.addEventListener("click", generateBadges);
  elements.allBadges.addEventListener("click", generateAllBadges);
  elements.restoreBadges.addEventListener("click", restoreBadges);
  elements.restoreSelected.addEventListener("click", restoreSelectedThumbnails);
  elements.modeNative.addEventListener("click", () => setOverlayVisibility(false));
  elements.modeBadge.addEventListener("click", () => setOverlayVisibility(true));
  elements.taskPause.addEventListener("click", async () => {
    manualControlGeneration++;
    if (!state.activeTask) return;
    state.paused = true;
    state.analysisAbort?.abort(Object.assign(new Error("分析已暂停"),{interrupted:true}));
    await serviceRequest(`/tasks/${state.activeTask.taskId}/pause`, { method: "POST" }).catch(() => {});
    renderTasks();
    setStatus("任务已暂停；当前请求完成后停止，点击继续可从断点恢复。", "neutral");
  });
  elements.taskResume.addEventListener("click", async () => {
    if (!state.activeTask || state.running) return;
    try { await configureActiveTask(); } catch (error) { setStatus(`配置失败：${error.message}`, "error"); return; }
    state.paused = false;
    const task = await (state.activeTask.activationPending
      ? serviceRequest(`/tasks/${state.activeTask.taskId}`)
      : serviceRequest(`/tasks/${state.activeTask.taskId}/resume`, { method: "POST" })).catch(() => null);
    if (task) { state.activeTask = task; await resumeStoredTask(task); }
  });
  elements.taskRetry.addEventListener("click", async () => {
    if (!state.activeTask || state.running) return;
    try { await configureActiveTask(); } catch (error) { setStatus(`配置失败：${error.message}`, "error"); return; }
    const task = await serviceRequest(`/tasks/${state.activeTask.taskId}/retry`, { method: "POST" }).catch(() => null);
    if (task) { state.activeTask = task; state.paused = false; await resumeStoredTask(task); }
  });
  elements.taskCancel.addEventListener("click", async () => {
    manualControlGeneration++;
    if (!state.activeTask || !["running", "pending", "paused"].includes(state.activeTask.status)) return;
    state.cancelled = true;
    state.analysisAbort?.abort(Object.assign(new Error("分析已取消"),{interrupted:true}));
    try {
      state.activeTask = await serviceRequest(`/tasks/${state.activeTask.taskId}/cancel`, { method: "POST" });
      renderTasks();
      setStatus("任务已取消：已完成的操作保留，正在执行的请求结束后停止；不会自动续跑。");
    } catch (error) { setStatus(`取消请求失败：${error.message}`, "error"); }
  });
  elements.taskHistory.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-task-id]");
    if (!button) return;
    if (state.running) return setStatus("请先暂停或等待当前任务结束，再查看其他任务。");
    try {
      state.activeTask = await serviceRequest(`/tasks/${button.dataset.taskId}`);
      manualTaskSelection = true;
      renderTasks();
    } catch (error) { setStatus(`读取任务失败：${error.message}`, "error"); }
  });
  document.querySelector("#task-history-prev").addEventListener("click",()=>{historyPage--;renderTaskHistory();});
  document.querySelector("#task-history-next").addEventListener("click",()=>{historyPage++;renderTaskHistory();});
  document.querySelector("#task-history-search").addEventListener("input",()=>{historyPage=0;renderTaskHistory();});
  document.querySelector("#upload-drafts").addEventListener("click", async event => {
    const button = event.target.closest("[data-resume-upload]");
    if (!button || state.running || planUploading) return;
    try {
      const compatibility = serviceCompatibility(await serviceRequest("/version"));
      if (!compatibility.compatible) throw new Error(compatibility.message);
      const libraryPath = eagleApi?.library?.path;
      const history = await serviceRequest("/tasks");
      if ((history.tasks || []).some(task => task.libraryPath === libraryPath && (task.status === "running" || task.execution))) throw new Error("请先结束当前资源库的在途任务");
      planUploading = true; setBusy(true);
      const task = await submitDurablePlan(serviceRequest, {libraryPath}, {
        store:planDrafts, resumeTaskId:button.dataset.resumeUpload,
        onProgress:(done,total)=>setStatus(`继续上传计划：${done}/${total}（尚未写入 Eagle）`),
      });
      if (task.libraryPath !== eagleApi?.library?.path) throw new Error("资源库已切换；计划已保存，但未开始执行");
      state.activeTask = task;
      if ((["pending", "running"].includes(task.status) || (task.activationPending && task.status === "paused")) && !task.execution) resumeStoredTask(task);
      else setStatus("计划已确认保留；不会重新执行已结束或由其他窗口持有的任务。");
    } catch (error) { setStatus(`续传失败：${error.message}`, "error"); }
    finally { planUploading = false; if (!state.running) setBusy(false); await refreshUploadDrafts(); }
  });
  const exportTaskReport = async (format) => {
    const task = state.activeTask || state.tasks[0];
    if (!task) return setStatus("没有可导出的任务。", "error");
    try {
      const snapshot = await serviceRequest(`/tasks/${task.taskId}`);
      const report = buildTaskReport(snapshot);
      const contents = format === "csv" ? taskExceptionsCsv(report) : JSON.stringify(report,null,2);
      const blob = new Blob([contents],{type:format === "csv" ? "text/csv;charset=utf-8" : "application/json"});
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");link.href=url;link.download=`${task.taskId}-${format === "csv" ? "exceptions" : "report"}.${format}`;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      setStatus(`已导出任务快照：${report.counts.total} 个单元、${report.counts.affectedFiles} 个文件；成功 ${report.counts.succeeded}，跳过 ${report.counts.skipped}，失败 ${report.counts.failed}。报告不是原片/预览验收证明。`,"success");
    } catch(error) {setStatus(`导出失败：${error.message}`,"error");}
  };
  elements.taskReportJson.addEventListener("click",()=>exportTaskReport("json"));
  elements.taskReportCsv.addEventListener("click",()=>exportTaskReport("csv"));
  elements.taskRecover.addEventListener("click", async () => {
    const task = state.activeTask;
    if (state.running || !task?.execution) return;
    if (task.libraryPath !== eagleApi?.library?.path) return setStatus("请打开任务原资源库后再恢复。", "error");
    if (!window.confirm("仅在旧插件窗口已经关闭、没有在途写入时继续。失联不代表请求已停止；本操作只释放执行权，不恢复缩略图或撤销标签。确认旧窗口已关闭？")) return;
    try {
      await serviceRequest(`/tasks/${task.taskId}/recover`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ownerId:task.execution.ownerId,libraryPath:task.libraryPath,confirmed:true}) });
      state.activeTask = await serviceRequest(`/tasks/${task.taskId}`);
      renderTasks();
      setStatus("失联执行权已释放，断点保留；点击继续运行剩余项目。");
    } catch (error) { setStatus(`释放失败：${error.message}`, "error"); }
  });
  elements.reload.addEventListener("click", async () => {
    if (!state.running) return location.reload();
    reloadRequested = true;
    state.paused = true;
    state.analysisAbort?.abort(Object.assign(new Error("为重载暂停分析"),{interrupted:true}));
    await serviceRequest(`/tasks/${state.activeTask.taskId}/pause`, { method: "POST" }).catch(() => {});
    setStatus("等待当前请求结束并保存断点后重载，不会中断在途写入。");
  });
  elements.diagnostics.addEventListener("click", async () => {
    await checkService();
    const serviceDiagnostics = await serviceRequest("/diagnostics").catch((error) => ({error:error.message}));
    const report = { pluginVersion: PLUGIN_VERSION, serviceUrl: SERVICE_URL, serviceObservation, overlayVisible: document.querySelector("#show-review-overlays").checked, legacyThumbnailMode: localStorage.getItem(MODE_KEY), taskCount: state.tasks.length, tasks: state.tasks, serviceDiagnostics, userAgent: navigator.userAgent, generatedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "eagle-culling-diagnostics.json"; link.click(); URL.revokeObjectURL(url);
    setStatus("诊断报告已导出。", "success");
  });
  document.querySelector("#service-recheck").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await checkService(); }
    finally { button.disabled = false; }
  });
  elements.search.addEventListener("input", () => { state.page = 0; render(); });
  const overlays = document.querySelector("#show-review-overlays");
  setOverlayVisibility(localStorage.getItem("eagle-culling-review-overlays") !== "false");
  overlays.addEventListener("change", () => setOverlayVisibility(overlays.checked));
  elements.filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    state.page = 0;
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
    if (action === "compare") openComparison(id);
    else if (action === "locate") await locateItem(id);
    else if (action === "group-best") await applyReviewState(id, "selected", true);
    else await applyReviewState(id, action);
  });
  const compareDialog = document.querySelector("#compare-dialog");
  document.querySelector("#compare-swap").addEventListener("click",()=>{
    if (!comparison) return;
    [comparison.leftId,comparison.rightId]=[comparison.rightId,comparison.leftId];renderComparison();
  });
  document.querySelector("#compare-close").addEventListener("click",()=>compareDialog.close());
  compareDialog.addEventListener("close",()=>{comparison=null;comparisonSignature=null;document.querySelector("#compare-panels").innerHTML="";});
  compareDialog.addEventListener("change",event=>{
    const side=event.target.dataset.compareSide;
    if (!side || !comparison) return;
    comparison[`${side}Id`]=event.target.value;renderComparison();
  });
  compareDialog.addEventListener("click",async event=>{
    const best=event.target.closest("[data-compare-best]");
    const locate=event.target.closest("[data-compare-locate]");
    if ((best || locate) && comparison?.libraryPath !== (eagleApi?.library?.path || null)) {
      compareDialog.close();return setStatus("资源库已切换，旧比较已关闭，未定位或写回。","error");
    }
    if (best) await applyReviewState(best.dataset.compareBest,"selected",true);
    else if (locate) await locateItem(locate.dataset.compareLocate);
  });
  document.addEventListener("keydown", async (event) => {
    if (compareDialog.open || event.target.matches("input, button, select, textarea")) return;
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
document.querySelector("#plugin-version").textContent = PLUGIN_VERSION;
try {
  const savedConfig = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
  if (Number.isSafeInteger(savedConfig?.concurrency) && savedConfig.concurrency > 0) elements.concurrency.value = savedConfig.concurrency;
  if ([0, 120, 250].includes(savedConfig?.delayMs)) elements.delay.value = savedConfig.delayMs;
  document.querySelector("#semantic-enabled").checked = savedConfig?.includeEmbeddings === true;
  document.querySelector("#high-quality-previews").checked = savedConfig?.highQualityPreviews === true;
} catch { /* malformed old settings use defaults */ }
for (const input of [elements.concurrency, elements.delay, document.querySelector("#semantic-enabled"), document.querySelector("#high-quality-previews")]) input.addEventListener("change", () => {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(queueConfig())); }
  catch (error) { setStatus(error.message, "error"); }
});

if (eagleApi) {
  refreshUploadDrafts();
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
