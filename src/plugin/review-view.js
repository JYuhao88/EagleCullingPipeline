import { currentGroup, decisionFor, reduceState, reviewProgress, filteredGroups, reviewIndex } from "./state.js";
import { rankedUnitIds, toggleSelection } from "./selection.js";
import { formatTotalScore, scoreParts } from "./score.js";
import { alignFaces, renderFace, renderFaceStrip, renderNativeFace } from "./face-view.js";

import { renderRuleReasons } from "./feedback.js";

const escapeReason = value => String(value ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const flagLabels = { "eyes-closed": "闭眼", blurry: "模糊", "possibly-blurry": "模糊",
  overexposed: "过曝", underexposed: "欠曝" };
const actionLabels = { selected: "保留", candidate: "候选", rejected: "淘汰" };
const confidenceLabel = group => ({ high: "把握高", low: "需确认", single: "单张" })[group.confidence] || "";

export function createReviewView({ root, state, setState, runId, getRunId = () => runId,
  onFilter, onBack, onDecision, onPreview, getCatalog = () => ({}), onExposure = () => {}, getPresentation = () => null }) {
  const reasonDrafts = new Map();
  let reasonRunId;
  let lastExposure = "";
  let exposurePending = Promise.resolve();
  function expose() {
    const group = currentGroup(state()), display = getPresentation(group);
    const ids = display?.order || rankedUnitIds(group);
    const cards = [...(root.querySelectorAll?.('#group .unit') || [])];
    const viewport = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    }).map(card => card.dataset.unitId);
    const key = JSON.stringify([getRunId(), group.id, ids, viewport, display?.aiVisible, display?.profileId]);
    if (group.id && lastExposure !== key) {
      lastExposure = key;
      const exposure = { groupId: group.id, order: ids, viewport,
        aiVisible: display?.aiVisible ?? true, queryPolicy: display?.queryPolicy || 'ranked-v1',
        allocationProbability: display?.allocationProbability ?? 1, clientVersion: 'learning-ui-v1' };
      exposurePending = exposurePending.then(() => onExposure(exposure));
    }
    return exposurePending;
  }
  let magnifier = false;
  let magnifierFace = 0;
  let magnifierRegion = "face";
  let magnifierGroup = null;

  const markup = new WeakMap();
  function renderList(container, rows) {
    const previous = markup.get(container);
    if (!container.children || !previous || previous.length !== rows.length) container.innerHTML = rows.join("");
    else rows.forEach((row, i) => { if (previous[i] !== row) container.children[i].outerHTML = row; });
    markup.set(container, rows);
  }
  function render() {
    if (reasonRunId !== getRunId()) { reasonDrafts.clear(); reasonRunId = getRunId(); }
    const viewState = state();
    const candidateToggle = root.querySelector("#candidateToggle");
    candidateToggle.setAttribute("aria-pressed", String(Boolean(viewState.candidateMode)));
    candidateToggle.textContent = `候选集：${viewState.candidateMode ? "开" : "关"}`;
    root.querySelector("#filter").value = viewState.filter;
    const group = currentGroup(viewState);
    if (group.id !== magnifierGroup) { magnifier = false; magnifierFace = 0; magnifierGroup = group.id; }
    const progress = reviewProgress(viewState);
    root.querySelector("#reviewProgress").textContent =
      `已审阅 ${progress.reviewed} / ${progress.total} 组${viewState.data?.page ? "（本页）" : ""}`;
    root.querySelector("#reviewTitle").textContent = groupTitle(viewState, group);
    renderList(root.querySelector("#groupList"), filteredGroups(viewState)
      .map(item => renderGroupList(viewState, item)));
    const display = getPresentation(group);
    const ids = display?.order || rankedUnitIds(group);
    const faceRows = alignFaces(ids.map(id => reviewIndex(viewState).results.get(id)));
    const comparing = viewState.faceCompare && faceRows.length > 0;
    magnifierFace = Math.min(magnifierFace, Math.max(0, faceRows.length - 1));
    const nativeButton = root.querySelector("#nativeMagnifier");
    if (nativeButton) {
      nativeButton.hidden = faceRows.length === 0;
      nativeButton.textContent = magnifier ? "关闭 1:1 放大镜（L）" : "1:1 放大镜（L）";
      nativeButton.setAttribute("aria-pressed", String(magnifier));
    }
    const nativeControls = root.querySelector("#nativeControls");
    if (nativeControls) {
      nativeControls.hidden = !magnifier;
      nativeControls.innerHTML = `<button data-native-face>切换脸 ${magnifierFace + 1}/${faceRows.length}（Shift+L）</button>`
        + `<button data-native-region>${magnifierRegion === "eyes" ? "眼部" : "脸部"}（E 切换）</button>`;
    }
    const faceButton = root.querySelector("#compareFaces");
    faceButton.hidden = faceRows.length === 0;
    faceButton.textContent = comparing ? "关闭人脸对比（F）" : "对比人脸（F）";
    faceButton.setAttribute("aria-pressed", String(Boolean(comparing)));
    renderList(root.querySelector("#unitStrip"), ids
      .map((unitId, index) => renderUnitThumbnail(viewState, group, unitId, index)));
    root.querySelector("#group").classList.toggle("face-comparing", Boolean(comparing || magnifier));
    root.querySelector("#group").classList.toggle("native-comparing", magnifier);
    renderList(root.querySelector("#group"), ids
      .map((unitId, index) => renderUnit(viewState, group, unitId, index,
        magnifier ? [faceRows[magnifierFace]] : comparing ? faceRows : null)));
    root.querySelector("#unitStrip .focus")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    root.querySelector("#review").classList.toggle("zoomed", viewState.zoomed);
    void expose();
    root.querySelector("#selectedCount").textContent = viewState.selected.length ? `已选 ${viewState.selected.length} 张` : "";
    const issueCounts = { bulkEyes: countUnreviewedIssue(viewState, "eyes-closed"),
      bulkBlurry: countUnreviewedIssue(viewState, "blurry") };
    for (const [id, count] of Object.entries(issueCounts)) {
      const button = root.querySelector(`#${id}`);
      button.hidden = false;
      button.disabled = count === 0;
      button.textContent = `${id === "bulkEyes" ? "闭眼" : "模糊"}照片标记淘汰（${count}）`;
    }
  }

  function countUnreviewedIssue(viewState, issue) {
    return (viewState.data?.results || []).filter(result => {
      const human = reviewIndex(viewState).human.has(result.unitId);
      return !human && (result.flags || []).includes(issue);
    }).length;
  }

  function groupTitle(viewState, group) {
    const ids = rankedUnitIds(group);
    if (!ids.length) return "当前筛选没有照片组，可切换「全部（含单张组）」查看";
    const suggestedId = ids.find(id => group.suggested?.[id] === "selected") || ids[0];
    const unit = reviewIndex(viewState).units.get(suggestedId);
    const name = reviewIndex(viewState).items.get(unit?.primaryItemId)?.name || "—";
    const groups = filteredGroups(viewState);
    const filterLabel = {
      multi: "多张组", issues: "有问题", unreviewed: "未审阅", reviewed: "已审",
      "eyes-closed": "闭眼", blurry: "模糊", "low-first": "先看需确认"
    }[viewState.filter];
    const suffix = filterLabel ? `（${filterLabel}）` : "";
    return `第 ${viewState.groupIndex + 1} / ${groups.length} 组${suffix} · ${ids.length} 张`
      + (group.hideAI ? " · 对照展示：请先独立选择" : ` · ${confidenceLabel(group)} · 建议保留 ${name}`);
  }

  function renderGroupList(viewState, group) {
    const index = viewState.data.groups.indexOf(group);
    const filteredIndex = filteredGroups(viewState).indexOf(group);
    const first = rankedUnitIds(group)[0];
    const preview = `${viewState.base}/runs/${getRunId()}/preview/${encodeURIComponent(first)}`;
    const issues = [...new Set(group.unitIds.flatMap(id => reviewIndex(viewState).results.get(id)?.flags || []))];
    const issueText = issues.map(issue => flagLabels[issue] || issue).join("、");
    return `<button class="group-list-item ${filteredIndex === viewState.groupIndex ? "active" : ""}" data-group-index="${filteredIndex}">
      <img src="${preview}" loading="lazy" alt="组 ${index + 1}" onerror="this.style.display='none'"><span class="group-list-meta">
      <strong>第 ${index + 1} 组 · ${group.unitIds.length} 张 · ${confidenceLabel(group)}</strong>
      <small>${group.unitIds.every(id => reviewIndex(viewState).human.has(id)) ? "已审" : "未审"} ${issueText}</small>
      </span></button>`;
  }

  function renderUnitThumbnail(viewState, group, unitId, index) {
    const unit = reviewIndex(viewState).units.get(unitId) || {};
    const item = reviewIndex(viewState).items.get(unit.primaryItemId) || {};
    const preview = `${viewState.base}/runs/${getRunId()}/preview/${encodeURIComponent(unitId)}`;
    const focus = index === viewState.unitIndex ? "focus" : "";
    const recommended = !group.hideAI && group.ranking?.find(entry => entry.unitId === unitId)?.rank === 1;
    const recommendation = recommended ? "<span class=\"thumbnail-recommend\">推荐</span>" : "";
    return `<button class="unit-strip-item ${focus}" data-unit-index="${index}"
      aria-label="${item.name || `第 ${index + 1} 张`}" aria-current="${index === viewState.unitIndex}">
      <img src="${preview}" loading="lazy" alt=""><span class="thumbnail-rank">${index + 1}</span>
      ${recommendation}</button>`;
  }

  function renderUnit(viewState, group, unitId, index, faceRows) {
    const unit = reviewIndex(viewState).units.get(unitId) || { id: unitId, formats: [] };
    const result = reviewIndex(viewState).results.get(unitId) || {};
    const ranking = group.ranking?.find(item => item.unitId === unitId) || {};
    const candidate = group.candidateSet?.entries?.find(item => item.unitId === unitId);
    const decision = decisionFor(viewState, unitId, group);
    const item = reviewIndex(viewState).items.get(unit.primaryItemId) || {};
    const endpoint = viewState.zoomed ? "detail" : "preview";
    const preview = `${viewState.base}/runs/${getRunId()}/${endpoint}/${encodeURIComponent(unitId)}`;
    const flags = (result.flags || []).map(flag => `<span class="badge">${flagLabels[flag] || flag}</span>`).join("");
    const scoreBars = scoreParts(result).map(part => {
      const width = part.value == null ? 0 : Math.min(100, Number(part.value) <= 1
        ? Number(part.value) * 100 : Number(part.value));
      const missing = part.value == null ? "missing" : "";
      return `<div class="metric"><span>${part.label}</span>`
        + `<b class="metric-value ${missing}">${part.display}</b>`
        + `<i><em style="width:${width}%"></em></i></div>`;
    }).join("");
    const focus = index === viewState.unitIndex ? "focus" : "";
    const selected = viewState.selected.includes(unitId) ? "selected" : "";
    const suggestion = actionLabels[group.suggested?.[unitId]] || "候选";
    const candidateText = candidate?.leaders?.length
      ? `各有所长：${candidate.leaders.join("、")}` :
      (group.candidateSet?.rejectedAll ? "本组无合格候选" : "");
    const current = decision.source === "human"
      ? actionLabels[decision.action] || decision.action
      : `未确认（建议 ${suggestion}）`;
    const sourceClass = decision.source === "human" ? "human" : "suggested";
    const actionClass = action => `action-${action}`;
    const faceContext = { base: viewState.base, runId: getRunId(), unitId };
    const images = faceRows
      ? `<div class="face-column">${faceRows.map((row, rowIndex) =>
        (magnifier ? renderNativeFace(row[index], faceContext, magnifierRegion)
          : renderFace(row[index], faceContext, `位置 ${rowIndex + 1}`))).join("")}</div>`
      : `<div class="image-wrap" data-preview="${unitId}"><img src="${preview}" loading="lazy" alt="${item.name || "预览"}"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="placeholder">预览不可用</span></div>${renderFaceStrip(result, faceContext)}`;
    return `<article class="unit ${focus} ${selected}" data-unit-id="${unitId}">
      ${!group.hideAI && ranking.rank === 1 ? "<span class=\"recommend\">推荐</span>" : ""}
      ${faceRows ? `<h3>${item.name || "未命名文件"}</h3>` : ""}${images}
      ${faceRows ? "" : `<h3>${item.name || "未命名文件"}</h3>`}<p class="rank" ${group.hideAI ? "hidden" : ""}>
        排名 ${ranking.rank ?? index + 1} ·
        <strong>${formatTotalScore(ranking.score ?? result.score)}</strong></p>
      <div class="metrics">${scoreBars}</div>
      <p class="reasons" ${group.hideAI ? "hidden" : ""}>
        ${(ranking.reasons || []).join("；")}${candidateText ? `；${candidateText}` : ""}</p>
      <p>${flags}</p>${renderRuleReasons(result, getCatalog())}
      <p ${group.hideAI ? "hidden" : ""}>建议：
        <strong class="${actionClass(group.suggested?.[unitId] || "candidate")}">${suggestion}</strong> ·
      当前：<strong class="${sourceClass} ${decision.source === "human"
        ? actionClass(decision.action) : "unconfirmed"}">${current}</strong></p>
      <label>自由理由（最多 500 字符）<textarea data-decision-reason maxlength="500"
        aria-label="自由理由">${escapeReason(reasonDrafts.get(unitId) ?? decision.reason ?? "")}</textarea></label>
      <div class="decision-buttons">${Object.entries(actionLabels).map(([action, label]) =>
        `<button data-action="${action}" class="${decision.source === "human" && decision.action === action ? "active" : ""}"
          >${label}</button>`).join("")}
        <button data-tie="true" class="${decision.tie ? "active" : ""}">并列</button></div>
    </article>`;
  }

  root.querySelector("#filter").addEventListener("change", event => {
    if (onFilter) { onFilter(event.target.value); return; }
    setState(reduceState(state(), { type: "filter", value: event.target.value })); render();
  });
  root.querySelector("#back").addEventListener("click", onBack);
  root.querySelector("#compareFaces").addEventListener("click", toggleFaces);
  root.querySelector("#candidateToggle").addEventListener("click", () => {
    setState(reduceState(state(), { type: "candidateMode", value: !state().candidateMode }));
    render();
  });

  root.querySelector("#nativeMagnifier")?.addEventListener("click", () => nativeAction("nativeMagnifier"));
  root.querySelector("#nativeControls")?.addEventListener("click", event => {
    if (event.target.closest("[data-native-face]")) nativeAction("nativeNextFace");
    if (event.target.closest("[data-native-region]")) nativeAction("nativeRegion");
  });

  function nativeAction(type) {
    const rows = alignFaces(currentGroup(state()).unitIds.map(id => state().data?.results?.find(item => item.unitId === id)));
    if (!rows.length) return;
    if (type === "nativeMagnifier") magnifier = !magnifier;
    if (type === "nativeNextFace") { magnifier = true; magnifierFace = (magnifierFace + 1) % rows.length; }
    if (type === "nativeRegion") { magnifier = true; magnifierRegion = magnifierRegion === "face" ? "eyes" : "face"; }
    render();
  }

  function toggleFaces() {
    magnifier = false;
    const group = currentGroup(state());
    const rows = alignFaces(group.unitIds.map(id => state().data?.results?.find(item => item.unitId === id)));
    if (!rows.length) return;
    setState(reduceState(state(), { type: "faceCompare" })); render();
  }
  root.querySelector("#groupList").addEventListener("click", event => {
    const button = event.target.closest("[data-group-index]"); if (!button) return;
    setState(reduceState(state(), { type: "group", index: Number(button.dataset.groupIndex) })); render();
  });
  root.querySelector("#unitStrip").addEventListener("click", event => {
    const button = event.target.closest("[data-unit-index]"); if (!button) return;
    setState(reduceState(state(), { type: "unit", index: Number(button.dataset.unitIndex) })); render();
  });
  root.querySelector("#group").addEventListener("input", event => {
    if (event.target.matches?.("[data-decision-reason]"))
      reasonDrafts.set(event.target.closest(".unit").dataset.unitId, event.target.value);
  });
  root.querySelector("#group").addEventListener("click", event => {
    const card = event.target.closest(".unit"); if (!card) return;
    if (event.target.closest("details, textarea, input")) return;
    const viewState = state(); const group = currentGroup(viewState);
    const ids = rankedUnitIds(group); const unitId = card.dataset.unitId;
    if (event.target.closest("[data-action]")) {
      onDecision(unitId, event.target.closest("[data-action]").dataset.action,
        { reason: card.querySelector("[data-decision-reason]")?.value.trim() || "" }); return;
    }
    if (event.target.closest("[data-tie]")) {
      onDecision(unitId, "candidate", { category: "candidate", tie: true, reason: "各有所长" }); return;
    }
    if (event.target.closest("[data-preview]") && !state().zoomed) {
      setState(reduceState(state(), { type: "zoom" }));
      root.querySelector("#review").classList.toggle("zoomed", state().zoomed);
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      const selected = toggleSelection(viewState.selected, unitId, {
        range: event.shiftKey, orderedIds: ids
      });
      setState(reduceState(viewState, { type: "selection", selected }));
    }
    setState(reduceState(state(), { type: "unit", index: ids.indexOf(unitId) })); render();
  });
  root.querySelector("#group").addEventListener("pointermove", event => {
    if (!state().zoomed) return;
    const wrap = event.target.closest(".image-wrap");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    root.querySelector("#group").style.setProperty("--zoom-x", `${x}%`);
    root.querySelector("#group").style.setProperty("--zoom-y", `${y}%`);
  });
  function closeNativeMagnifier() {
    if (!magnifier) return false;
    magnifier = false; render(); return true;
  }
  function decisionReason(unitId) {
    const card = [...(root.querySelectorAll("#group .unit") || [])].find(c => c.dataset.unitId === unitId);
    return card?.querySelector("[data-decision-reason]")?.value.trim();
  }
  return { decisionReason, render, expose, toggleFaces, nativeAction, closeNativeMagnifier };
}
