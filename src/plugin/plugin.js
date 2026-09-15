import {
  REVIEW_STATES,
  buildReviewSections,
  matchesReviewFilter,
  mergeReviewStateTags,
  summarize,
} from "./review-model.js";

const SERVICE_URL = "http://127.0.0.1:43125";
const MAX_BATCH_SIZE = 500;
const eagleApi = globalThis.eagle;
const demoMode = !eagleApi && new URLSearchParams(location.search).has("demo");

const elements = {
  status: document.querySelector("#status"),
  service: document.querySelector("#service-state"),
  inspect: document.querySelector("#inspect"),
  analyze: document.querySelector("#analyze"),
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

const state = { items: [], groups: [], liveItems: new Map(), filter: "all", focusedId: null };

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
  const thumbnail = record.thumbnailURL || record.fileURL || "";
  const thumbnailMarkup = thumbnail
    ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(record.name)} 的缩略图" loading="lazy">`
    : `<span class="format-badge">${escapeHtml((record.ext || "文件").toUpperCase())}</span>`;
  const actionLabels = { selected: "保留", candidate: "候选", rejected: "待删复核" };
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

async function checkService() {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setServiceState("ready", "本地分析服务已连接");
  } catch {
    setServiceState("offline", "分析服务未启动");
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
  elements.inspect.addEventListener("click", loadSelection);
  elements.analyze.addEventListener("click", analyzeSelection);
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
    { id: "demo-1", name: "DSC08421", ext: "JPG", qualityScore: 91, width: 7728, height: 5152, tags: ["旅行", "ai:selected", "ai:paired"], qualityFlags: [], thumbnailURL: svgThumbnail("DSC08421", ["#997053", "#263f4b"]) },
    { id: "demo-2", name: "DSC08422", ext: "ARW", qualityScore: 82, width: 7728, height: 5152, tags: ["ai:original", "ai:paired", "ai:candidate"], qualityFlags: ["possibly-blurry"], analysisSource: "proxy", thumbnailURL: svgThumbnail("DSC08422", ["#6d544a", "#1c3038"]) },
    { id: "demo-3", name: "B0001731", ext: "3FR", qualityScore: 76, width: 11656, height: 8742, tags: ["ai:original", "ai:pair-uncertain"], qualityFlags: ["eyes-closed"], analysisSource: "proxy", thumbnailURL: svgThumbnail("B0001731", ["#5c665e", "#23262c"]) },
    { id: "demo-4", name: "B0001731", ext: "HEIC", qualityScore: 79, width: 4096, height: 3072, tags: ["ai:rejected", "ai:pair-uncertain"], qualityFlags: ["overexposed"], metrics: { clippedHigh: .083 }, thumbnailURL: svgThumbnail("B0001731 HEIC", ["#b99b74", "#4a5964"]) },
  ];
  state.items = base;
  state.groups = [{ groupId: "phash-0001", size: 2, representativeId: "demo-1", items: base.slice(0, 2) }];
  state.focusedId = "demo-1";
  setServiceState("ready", "界面演示数据");
  setStatus("演示模式：中文结论、相似组、RAW/JPG 配对和审阅状态均可预览；写入按钮已停用。", "success");
  render();
}

bindEvents();

if (eagleApi) {
  checkService();
  eagleApi.onPluginCreate(loadSelection);
} else if (demoMode) loadDemo();
else {
  setServiceState("offline", "未检测到 Eagle 环境");
  setStatus("请从 Eagle 的插件菜单打开本窗口；本地预览可在地址后加 ?demo=1。", "error");
}
