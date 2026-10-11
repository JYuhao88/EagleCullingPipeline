import { createLearningPanel } from "./learning-panel.js";
import { createReviewUx } from "./review-ux.js";
import { createApi } from "./api.js";
import { createReviewView } from "./review-view.js";
import { createStartView } from "./start-view.js";
import { createWritebackDialog } from "./writeback-dialog.js";
import { keyboardAction } from "./keyboard.js";
import {
  applyDecisionBatch,
  currentGroup,
  decisionFor,
  decisionSnapshot,
  initialState,
  filteredGroups,
  refreshGroups,
  reduceState,
  undoDecision
} from "./state.js";
import { resolveBase } from "./state.js";
import { decisionRequests, issueUnitIds, highConfidenceGroups, unreviewedSuggestions } from "./batch.js";
import { createPersonalization } from "./personalization.js";
import { rankedUnitIds, selectionTargets } from "./selection.js";

import { createFeedbackRecorder, defaultRejectReasons, winnerChanges, escapeHtml } from "./feedback.js";

const root = document;
const reviewUx = createReviewUx({ root });
let viewState = { ...initialState };
let api = createApi(viewState.base);
let reviewView = null;
let writebackDialog = null;
let previewUnitId = null;
let personalization = null;
let learningPanel = null;
let catalog = { reasons: [], rules: [] };
let reasonSession = null;
const feedback = createFeedbackRecorder({ api: (...args) => api(...args), onError: error => {
  root.querySelector("#feedbackStatus").textContent = `反馈记录失败（选片和写回可继续）：${error.message}`;
} });

function closeReasons() {
  reasonSession = null;
  root.querySelector("#rejectReasons").hidden = true;
}

function renderReasonChips() {
  if (!reasonSession) return;
  root.querySelector("#rejectReasonsTitle").textContent = `已淘汰 ${reasonSession.entries.length} 张 · 理由（可多选）`;
  root.querySelector("#rejectReasonChips").innerHTML = catalog.reasons.map((reason, index) => {
    const count = reasonSession.entries.filter(entry => entry.reasons.includes(reason.id)).length;
    return `<button data-reason="${escapeHtml(reason.id)}" aria-pressed="${count === reasonSession.entries.length}"
      title="${count ? `已选 ${count} 张` : '未选'}">${index < 9 ? `${index + 1} ` : ''}${escapeHtml(reason.label)}
      ${count && count < reasonSession.entries.length ? '（部分）' : ''}</button>`;
  }).join('');
  root.querySelector("#rejectReasons").hidden = false;
}

function toggleReason(id) {
  if (!reasonSession || !id) return;
  const remove = reasonSession.entries.every(entry => entry.reasons.includes(id));
  for (const entry of reasonSession.entries) {
    entry.reasons = remove ? entry.reasons.filter(reason => reason !== id) : [...new Set([...entry.reasons, id])];
    feedback.revise(entry.handle, entry.reasons);
  }
  renderReasonChips();
}

function recordDecisions(before, decisions, previous, { showReasons = true, preference = true } = {}) {
  closeReasons();
  const handles = [];
  const entries = [];
  for (const decision of decisions) {
    // Candidate is also an explicit keep-in-the-pool decision.
    const reasons = decision.action === 'rejected' ? defaultRejectReasons(
      before.data.results.find(result => result.unitId === decision.unitId), catalog) : [];
    const handle = feedback.record(before.runId, { unitId: decision.unitId,
      action: decision.action === 'rejected' ? 'reject' : 'keep', reasons });
    handles.push(handle);
    if (decision.action === 'rejected') entries.push({ handle, reasons });
  }
  if (preference) for (const pair of winnerChanges(before, decisions)) handles.push(feedback.record(before.runId, pair));
  previous.feedback = handles;
  if (showReasons && entries.length && catalog.reasons.length) {
    reasonSession = { entries }; renderReasonChips();
  }
}

root.querySelector("#rejectReasonChips").addEventListener("click", event => {
  toggleReason(event.target.closest('[data-reason]')?.dataset.reason);
});
root.querySelector("#closeRejectReasons").addEventListener("click", closeReasons);
root.querySelector("#clearRejectReasons").addEventListener("click", () => {
  for (const entry of reasonSession?.entries || []) { entry.reasons = []; feedback.revise(entry.handle, []); }
  renderReasonChips();
});
root.querySelector('#group').addEventListener('click', event => {
  if (!event.target.closest('[data-action], details')) closeReasons();
});
// Pointer navigation closes the temporary digit-key context.
for (const id of ['unitStrip', 'groupList', 'filter', 'back', 'dryRun']) {
  root.querySelector(`#${id}`).addEventListener('click', closeReasons);
}

function renderDecisions() {
  reviewView.render();
  globalThis.dispatchEvent(new CustomEvent("culling:decision-rendered"));
  void personalization?.scheduleRefresh();
  void learningPanel?.refresh();
}

function setState(next) {
  viewState = next;
}

function state() {
  return viewState;
}

function scrollFocusedCard() {
  root.querySelector(".unit.focus")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function inInput(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function previewIds() {
  return currentGroup(viewState).unitIds;
}

function renderPreview() {
  const ids = previewIds();
  const index = Math.max(0, ids.indexOf(previewUnitId));
  previewUnitId = ids[index] || ids[0] || null;
  const unit = viewState.data?.units?.find(item => item.id === previewUnitId);
  const item = viewState.data?.items?.find(candidate => candidate.id === unit?.primaryItemId);
  const image = root.querySelector("#previewImage");
  image.src = `${viewState.base}/runs/${viewState.runId}/detail/${encodeURIComponent(previewUnitId)}`;
  image.alt = item?.name || "全屏预览";
  root.querySelector("#previewCaption").textContent = `${index + 1} / ${ids.length} · ${item?.name || "未命名文件"}`;
}

function openPreview(unitId) {
  previewUnitId = unitId;
  renderPreview();
  const dialog = root.querySelector("#previewDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.hidden = false;
}

function closePreview() {
  const dialog = root.querySelector("#previewDialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.hidden = true;
  previewUnitId = null;
}

function movePreview(delta) {
  const ids = previewIds();
  const next = Math.max(0, Math.min(ids.length - 1, ids.indexOf(previewUnitId) + delta));
  previewUnitId = ids[next];
  renderPreview();
}

let reviewRequest = 0;
async function loadReviewPage(cursor = 0, filter = viewState.filter) {
  const requestVersion = ++reviewRequest;
  const query = `limit=20&cursor=${cursor}&filter=${encodeURIComponent(filter)}`;
  const runId = viewState.runId;
  const data = await api(`/runs/${runId}/results?${query}`);
  const response = await api(`/runs/${runId}/decisions?${query}`);
  if (reviewRequest !== requestVersion || viewState.runId !== runId) return;
  setState({ ...viewState, data, decisions: response.decisions, filter,
    groupIndex: 0, unitIndex: 0, selected: [] });
  reviewView.render();
  renderPageControls();
}

function renderPageControls() {
  const page = viewState.data?.page;
  const label = root.querySelector('#pageStatus');
  if (!label || !page) return;
  label.textContent = page.total
    ? `组 ${page.cursor + 1}–${Math.min(page.cursor + page.limit, page.total)} / ${page.total}` : "没有符合条件的组";
  root.querySelector('#previousPage').disabled = page.cursor === 0;
  root.querySelector('#nextPage').disabled = page.nextCursor === null;
}

async function openRun(runId) {
  const requestVersion = ++reviewRequest;
  root.querySelector("#loading").hidden = false;
  try {
    closeReasons();
    catalog = await api('/api/feedback/catalog').catch(error => {
      root.querySelector('#feedbackStatus').textContent = `理由词表加载失败（仍可选片）：${error.message}`;
      return { reasons: [], rules: [] };
    });
    const query = `limit=20&filter=${encodeURIComponent(viewState.filter)}`;
    const data = await api(`/runs/${runId}/results?${query}`);
    const response = await api(`/runs/${runId}/decisions?${query}`);
    if (reviewRequest !== requestVersion) return;
    setState(reduceState(viewState, { type: "load", runId, data, decisions: response.decisions }));
    root.querySelector("#start").hidden = true;
    root.querySelector("#review").hidden = false;
    root.querySelector("#reportCsv").href = `${viewState.base}/runs/${runId}/report?format=csv`;
    root.querySelector("#reportJson").href = `${viewState.base}/runs/${runId}/report?format=json`;
    root.querySelector("#revertWriteback").hidden = !data.writebackAvailable;
    await learningPanel?.refresh();
    renderDecisions();
    renderPageControls();
    reviewUx.enter();
  } catch (error) {
    root.querySelector("#health").textContent = `加载失败：${error.message}`;
    throw error;
  } finally {
    root.querySelector("#loading").hidden = true;
  }
}

function closeReview() {
  root.querySelector("#review").hidden = true;
  root.querySelector("#start").hidden = false;
  void startView.checkHealth();
}

async function saveDecision(unitId, action, metadata = {}, explicitTargets = null) {
  if (metadata.reason === undefined && !explicitTargets) {
    const reason = reviewView.decisionReason(unitId);
    if (reason !== undefined) metadata = { ...metadata, reason };
  }
  const targets = explicitTargets || selectionTargets(viewState.selected, unitId);
  const before = viewState;
  const decisions = decisionRequests(targets, action, metadata);
  const previous = decisionSnapshot(viewState, targets);
  await reviewView.expose();
  const response = await api(`/runs/${viewState.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions, learning: learningPanel?.context() })
  });
  if (response.learningWarning) root.querySelector("#learningStatus").textContent = `决定已保存；反馈失败：${response.learningWarning}`;
  recordDecisions(before, decisions, previous);
  setState(applyDecisionBatch(viewState, decisions, previous));
  renderDecisions();
  root.querySelector(".unit.focus")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

async function decideCurrentGroup(action, metadata = {}) {
  const group = currentGroup(viewState);
  const allUnitIds = filteredGroups(viewState)[viewState.groupIndex]?.unitIds || group.unitIds;
  if (!group.unitIds.length) return;
  const before = viewState;
  const decisions = decisionRequests(allUnitIds, action, metadata);
  const previous = decisionSnapshot(viewState, allUnitIds);
  await reviewView.expose();
  const response = await api(`/runs/${viewState.runId}/decisions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions, learning: learningPanel?.context() })
  });
  if (response.learningWarning) root.querySelector("#learningStatus").textContent = `决定已保存；反馈失败：${response.learningWarning}`;
  recordDecisions(before, decisions, previous);
  setState(applyDecisionBatch(viewState, decisions, previous));
  renderDecisions();
}

async function selectBest() {
  const before = viewState;
  const group = currentGroup(viewState);
  const selected = rankedUnitIds(group)[viewState.unitIndex];
  if (!selected) return;
  const previous = decisionSnapshot(viewState, group.unitIds);
  const decisions = group.unitIds.map(unitId => {
    const current = decisionFor(viewState, unitId, group).action;
    const action = unitId === selected ? "selected" : current === "rejected" ? "rejected" : "candidate";
    return { unitId, action, flags: [], source: "human" };
  });
  await reviewView.expose();
  const response = await api(`/runs/${viewState.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions, learning: learningPanel?.context() })
  });
  if (response.learningWarning) root.querySelector("#learningStatus").textContent = `决定已保存；反馈失败：${response.learningWarning}`;
  recordDecisions(before, decisions, previous);
  setState(applyDecisionBatch(viewState, decisions, previous));
  renderDecisions();
}

async function acceptUnreviewed(mode = "filtered") {
  // Another review tab may have saved human decisions since this page loaded.
  // Refresh before defining "unreviewed" and before taking the undo snapshot.
  const latest = await api(`/runs/${viewState.runId}/decisions`);
  setState({ ...viewState, decisions: latest.decisions });
  const before = viewState;
  const human = unitId => viewState.decisions.some(item => item.unitId === unitId && item.source === "human");
  const source = mode === "high" ? highConfidenceGroups(viewState.data.groups, viewState.decisions)
    : mode === "singles" ? viewState.data.groups.filter(group => group.unitIds.length === 1) : filteredGroups(viewState);
  const groups = source.filter(group => group.unitIds.some(unitId => !human(unitId)));
  const decisions = unreviewedSuggestions(groups, viewState.decisions);
  const ids = decisions.map(item => item.unitId);
  const label = mode === "high" ? "把握高的" : mode === "singles" ? "单张" : "";
  if (!ids.length || !confirm(`将接受 ${groups.length} 个${label}组、${ids.length} 张的建议，继续吗？`)) return;
  const previous = decisionSnapshot(viewState, ids);
  await reviewView.expose();
  const response = await api(`/runs/${viewState.runId}/decisions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions, learning: learningPanel?.context({ signal: "bulk" }) })
  });
  if (response.learningWarning) root.querySelector("#learningStatus").textContent = `决定已保存；反馈失败：${response.learningWarning}`;
  recordDecisions(before, decisions, previous, { preference: false });
  setState(applyDecisionBatch(viewState, decisions, previous)); renderDecisions();
}

async function correctGroup(action, body, focusUnitId = null) {
  closeReasons();
  const runId = viewState.runId;
  await api(`/runs/${runId}/groups/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const [data, response] = await Promise.all([
    api(`/runs/${runId}/results?limit=20&filter=${encodeURIComponent(viewState.filter)}`),
    api(`/runs/${runId}/decisions?limit=20&filter=${encodeURIComponent(viewState.filter)}`)
  ]);
  setState(refreshGroups(viewState, data, response.decisions, focusUnitId));
  reviewView.render();
  scrollFocusedCard();
  root.querySelector("#writeback").textContent = "分组修正已保存，人工决定已保留；建议已按新组更新。";
}

async function moveUnit(delta, newGroup = false) {
  const group = currentGroup(viewState);
  const unitId = rankedUnitIds(group)[viewState.unitIndex];
  if (!unitId) return;
  const all = viewState.data.groups;
  const target = all[all.findIndex(item => item.id === group.id) + delta];
  if (!newGroup && !target) throw new Error("没有相邻组可移动");
  await correctGroup("move", { unitId, targetGroupId: newGroup ? "new" : target.id }, unitId);
}

async function mergePrevious() {
  const group = currentGroup(viewState);
  const all = viewState.data.groups;
  const previous = all[all.findIndex(item => item.id === group.id) - 1];
  if (!previous) throw new Error("没有上一组可合并");
  await correctGroup("merge", { groupIds: [previous.id, group.id] }, group.unitIds[0]);
}

async function splitSelected() {
  const group = currentGroup(viewState);
  const unitIds = group.unitIds.filter(id => viewState.selected.includes(id));
  if (!unitIds.length || unitIds.length === group.unitIds.length) throw new Error("请选择组内部分照片再拆分");
  await correctGroup("split", { groupId: group.id, unitIds }, unitIds[0]);
}

async function undoLast() {
  const handles = viewState.history.at(-1)?.feedback;
  const result = undoDecision(viewState);
  if (!result.requests.length) return;
  await reviewView.expose();
  const response = await api(`/runs/${viewState.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions: result.requests, learning: learningPanel?.context({ undo: true }) })
  });
  closeReasons();
  feedback.undo(handles);
  setState(result.state);
  renderDecisions();
}

root.addEventListener("keydown", async event => {
  // A modal owns the keyboard; review shortcuts resume after it closes.
  if (root.querySelector('dialog[open]:not(#previewDialog)')) return;
  if (previewUnitId && event.key === "Escape") {
    event.preventDefault();
    closePreview();
    return;
  }
  if (previewUnitId && event.key === "ArrowLeft") {
    event.preventDefault();
    movePreview(-1);
    return;
  }
  if (previewUnitId && event.key === "ArrowRight") {
    event.preventDefault();
    movePreview(1);
    return;
  }
  const action = keyboardAction(event, inInput(event.target), Boolean(reasonSession) && !previewUnitId);
  if (!action || root.querySelector("#review").hidden) return;
  event.preventDefault();
  try {
    if (action.type === 'rejectReason') { toggleReason(catalog.reasons[action.index]?.id); return; }
    if (action.type === 'closeReasons') { closeReasons(); return; }
    if (['unit', 'group', 'zoom', 'moveUnit', 'newGroup'].includes(action.type)) closeReasons();
    if (action.type === "decision") {
      const group = currentGroup(viewState);
      const unitId = rankedUnitIds(group)[viewState.unitIndex];
      if (unitId) await saveDecision(unitId, action.action);
    }
    if (action.type === "moveUnit") await moveUnit(action.delta);
    if (action.type === "newGroup") await moveUnit(0, true);
    if (action.type === "selectBest") await selectBest();
    if (action.type === "undo") await undoLast();
    if (action.type === "unit") {
      setState(reduceState(viewState, {
        type: "unit",
        index: viewState.unitIndex + action.delta
      }));
      reviewView.render();
      scrollFocusedCard();
    }
    if (action.type === "group") {
      const page = viewState.data?.page;
      const next = viewState.groupIndex + action.delta;
      if (page && next >= filteredGroups(viewState).length && page.nextCursor !== null) {
        await loadReviewPage(Number(page.nextCursor));
        return;
      }
      if (page && next < 0 && page.cursor > 0) {
        await loadReviewPage(Math.max(0, page.cursor - page.limit));
        setState(reduceState(viewState, { type: 'group', index: filteredGroups(viewState).length - 1 }));
        reviewView.render();
        return;
      }
      setState(reduceState(viewState, {
        type: "group",
        index: viewState.groupIndex + action.delta
      }));
      reviewView.render();
      scrollFocusedCard();
    }
    if (action.type === "syncZoom") {
      setState(reduceState(viewState, { type: "zoom" }));
      reviewView.render();
    }
    if (action.type === "faceCompare") reviewView.toggleFaces();
    if (action.type === "zoom") openPreview(rankedUnitIds(currentGroup(viewState))[viewState.unitIndex]);
    if (["nativeMagnifier", "nativeNextFace", "nativeRegion"].includes(action.type)) reviewView.nativeAction(action.type);
    if (action.type === "selectAll") {
      setState(reduceState(viewState, { type: "selection", selected: currentGroup(viewState).unitIds })); reviewView.render();
    }
    if (action.type === "clearSelection" || action.type === "escape") {
      if (reviewView.closeNativeMagnifier()) return;
      if (viewState.faceCompare) {
        setState(reduceState(viewState, { type: "faceCompare", value: false }));
        reviewView.render();
        return;
      }
      let next = reduceState(viewState, { type: "selection", selected: [] });
      if (viewState.zoomed) next = reduceState(next, { type: "zoom", value: false });
      setState(next);
      reviewView.render();
    }
    if (action.type === "help") root.querySelector("#shortcutHelp").showModal?.();
  } catch (error) {
    root.querySelector("#writeback").textContent = `保存失败：${error.message}`;
  }
});

root.querySelector("#base").value = viewState.base;
root.querySelector("#base").addEventListener("change", event => {
  viewState.base = event.target.value.replace(/\/$/, "");
  localStorage.setItem("eagle-culling-base", viewState.base);
  api = createApi(viewState.base);
  void startView.checkHealth();
});

const startView = createStartView({ root, api, getApi: () => api, onRun: openRun, autoCheck: false });
reviewView = createReviewView({ root, state, setState,
  onFilter: filter => loadReviewPage(0, filter).catch(error => {
    root.querySelector("#writeback").textContent = `暂时无法加载照片组：${error.message}。请检查服务连接后重新选择筛选。`; }),
  getRunId: () => viewState.runId, onBack: closeReview, onDecision: saveDecision,
  onPreview: openPreview, getCatalog: () => catalog,
  onExposure: exposure => api(`/runs/${viewState.runId}/learning/exposure?groupId=${encodeURIComponent(exposure.groupId)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...exposure, ...learningPanel?.context() })
  }).catch(error => { root.querySelector("#learningStatus").textContent = `曝光记录失败：${error.message}`; }),
  getPresentation: group => learningPanel?.presentation(group) });
root.querySelector("#tieGroup").addEventListener("click", () => decideCurrentGroup("candidate", {
  category: "candidate", tie: true, reason: "各有所长"
}).catch(error => { root.querySelector("#writeback").textContent = `保存失败：${error.message}`; }));
root.querySelector("#rejectGroup").addEventListener("click", () => decideCurrentGroup("rejected", {
  category: "group", tie: false, reason: "整组都有严重硬伤"
}).catch(error => { root.querySelector("#writeback").textContent = `保存失败：${error.message}`; }));
personalization = createPersonalization({ root, api: (...args) => api(...args), state, setState,
  render: () => reviewView.render() });
learningPanel = createLearningPanel({ root, api: (...args) => api(...args), state, setState,
  render: () => reviewView.render() });
writebackDialog = createWritebackDialog({ root, api: (...args) => api(...args),
  getRunId: () => viewState.runId });
for (const [id, direction] of [['previousPage', -1], ['nextPage', 1]]) {
  root.querySelector(`#${id}`)?.addEventListener('click', () => {
    const page = viewState.data.page;
    const cursor = direction < 0 ? Math.max(0, page.cursor - page.limit) : Number(page.nextCursor);
    loadReviewPage(cursor).catch(error => {
      root.querySelector('#writeback').textContent = `暂时无法翻页：${error.message}。请检查服务连接后重试。`;
    });
  });
}
window.loadRun = openRun;

root.querySelector("#acceptGroup").addEventListener("click", () => selectBest().catch(error => {
  root.querySelector("#writeback").textContent = `保存失败：${error.message}`;
}));
root.querySelector("#acceptUnreviewed").addEventListener("click", () => acceptUnreviewed().catch(error => {
  root.querySelector("#writeback").textContent = `保存失败：${error.message}`;
}));
for (const [id, handler] of [
  ["movePrevious", () => moveUnit(-1)], ["moveNext", () => moveUnit(1)], ["newGroup", () => moveUnit(0, true)],
  ["mergePrevious", mergePrevious], ["splitSelected", splitSelected], ["undoGroup", () => correctGroup("undo", {})],
  ["acceptSingles", () => acceptUnreviewed("singles")],
  ["acceptHighConfidence", () => acceptUnreviewed("high")]
]) {
  root.querySelector(`#${id}`).addEventListener("click", () => handler().catch(error => {
    root.querySelector("#writeback").textContent = error.message;
  }));
}
root.querySelector("#closeHelp").addEventListener("click", () => root.querySelector("#shortcutHelp").close());
root.querySelector("#closePreview").addEventListener("click", closePreview);
root.querySelector("#previewPrevious").addEventListener("click", () => movePreview(-1));
root.querySelector("#previewNext").addEventListener("click", () => movePreview(1));
root.querySelector("#previewDialog").addEventListener("click", event => {
  if (event.target.id === "previewDialog") closePreview();
});
for (const [buttonId, issue] of [["bulkEyes", "eyes-closed"], ["bulkBlurry", "blurry"]]) {
  root.querySelector(`#${buttonId}`).addEventListener("click", async () => {
    const ids = issueUnitIds(viewState.data.groups, viewState.data.results, issue, viewState.decisions);
    if (!ids.length || !confirm(`将 ${ids.length} 张${issue === "blurry" ? "模糊" : "闭眼"}照片标记淘汰，继续吗？`)) return;
    await saveDecision(ids[0], "rejected", {}, ids);
  });
}

resolveBase().then(base => {
  viewState.base = base;
  api = createApi(base);
  root.querySelector("#base").value = base;
  return startView.checkHealth();
}).catch(() => {});
