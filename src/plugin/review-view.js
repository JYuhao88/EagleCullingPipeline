import { currentGroup, decisionFor, reduceState, reviewProgress, filteredGroups, reviewIndex } from "./state.js";
import { rankedUnitIds, toggleSelection } from "./selection.js";
import { formatTotalScore, scoreParts } from "./score.js";
import { alignFaces, renderFace, renderFaceStrip, renderNativeFace } from "./face-view.js";

import { renderRuleReasons } from "./feedback.js";
import { displayUrl } from './display-url.js';

const escapeReason = value => String(value ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const flagLabels = { "eyes-closed": "闭眼", blurry: "模糊", "possibly-blurry": "模糊",
  overexposed: "过曝", underexposed: "欠曝" };
const actionLabels = { selected: "精选", candidate: "候选", rejected: "淘汰" };
const actionKeys = { selected: 1, candidate: 2, rejected: 3 };
export function reviewLayout(count, width = 1200, height = 700, mode = 'compare', focus = 0, aspect = 1.5) {
  const capacity = mode === 'single' ? 1 : mode === 'grid' ? Math.max(1, Math.floor(width / 160) * Math.floor(height / 140)) : 8;
  const clamped = Math.max(0, Math.min(count - 1, focus));
  const start = Math.floor(clamped / capacity) * capacity;
  const visible = Math.min(capacity, Math.max(0, count - start));
  const columns = mode === 'single' ? 1 : mode === 'grid' ? Math.max(1, Math.min(visible, Math.floor(width / 160)))
    : compareColumns(visible, width, height, aspect);
  return { start, end: start + visible, columns, rows: Math.max(1, Math.ceil(visible / columns)) };
}

// Pick the column count that gives each contained photo the largest displayed area.
function compareColumns(visible, width, height, aspect) {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.5;
  let best = 1, bestArea = -1;
  for (let columns = 1; columns <= Math.max(1, Math.min(visible, 4)); columns += 1) {
    const rows = Math.ceil(visible / columns);
    const imageWidth = Math.min(width / columns, (height / rows) * ratio);
    const area = imageWidth * imageWidth / ratio;
    if (area > bestArea + 1) { best = columns; bestArea = area; }
  }
  return best;
}

export function groupAspect(viewState, unitIds) {
  const units = new Map((viewState.data?.units || []).map(unit => [unit.id, unit]));
  const items = new Map((viewState.data?.items || []).map(item => [item.id, item]));
  const ratios = unitIds.map(id => {
    const unit = units.get(id);
    const item = items.get(unit?.primaryItemId || unit?.itemIds?.[0]);
    return item?.width > 0 && item?.height > 0 ? item.width / item.height : null;
  }).filter(Boolean).sort((a, b) => a - b);
  return ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1.5;
}
export function decisionBadge(decision, hideAI = false) {
  if (hideAI && decision.source !== 'human') return '';
  const symbol = decision.tie ? '≈' : { selected: '★', rejected: '✕' }[decision.action];
  if (!symbol) return '';
  const human = decision.source === 'human';
  return `<span class="decision-mark action-${decision.action} ${human ? 'human' : 'suggested'}"
    title="${human ? '已决定' : 'AI 建议'}：${actionLabels[decision.action]}${decision.tie ? ' · 并列' : ''}">
    ${human ? '' : '建议 '}${symbol}</span>`;
}
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
  let detailsOpen = false;
  let viewMode = "compare";
  let sidebarOpen = false;
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
    root.querySelector("#review")?.classList.toggle("info-open", detailsOpen);
    const candidateToggle = root.querySelector("#candidateToggle");
    candidateToggle.setAttribute("aria-pressed", String(Boolean(viewState.candidateMode)));
    candidateToggle.textContent = `候选集：${viewState.candidateMode ? "开" : "关"}`;
    root.querySelector("#filter").value = viewState.filter;
    const group = currentGroup(viewState);
    if (group.id !== magnifierGroup) {
      magnifier = false; magnifierFace = 0; magnifierGroup = group.id;
      const scroller = root.querySelector(".review-main");
      if (scroller) scroller.scrollTop = 0;
    }
    const progress = viewState.data?.reviewProgress || reviewProgress(viewState);
    root.querySelector("#reviewProgress").textContent =
      `已审 ${progress.reviewed ?? "—"} / ${progress.total}`;
    root.querySelector("#reviewTitle").textContent = groupTitle(viewState, group);
    if (sidebarOpen) renderList(root.querySelector("#groupList"), filteredGroups(viewState)
      .map(item => renderGroupList(viewState, item)));
    const display = getPresentation(group);
    const ids = display?.order || rankedUnitIds(group);
    const bounds = reviewLayout(ids.length, root.querySelector("#group").clientWidth || 1200,
      root.querySelector("#group").clientHeight || 700, viewMode, viewState.unitIndex, groupAspect(viewState, ids));
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
    renderList(root.querySelector("#group"), ids.length ? ids.slice(bounds.start, bounds.end)
      .map((unitId, offset) => renderUnit(viewState, group, unitId, bounds.start + offset,
        magnifier ? [faceRows[magnifierFace]] : comparing ? faceRows : null))
      : ['<p class="review-empty">这个筛选下没有照片组。请在顶部切换「全部（含单张组）」，或返回主页开始新的分析。</p>']);
    const decided = ids.filter(id => reviewIndex(viewState).human.has(id)).length;
    const decidedLabel = root.querySelector("#groupDecided");
    if (decidedLabel) {
      decidedLabel.textContent = !ids.length ? "" : decided === ids.length ? `✓ 本组已完成（${decided}/${ids.length}）`
        : `本组已确认 ${decided}/${ids.length} 张`;
      decidedLabel.className = decided && decided === ids.length ? "group-done" : "";
    }
    layout(ids);
    root.querySelector("#review")?.classList.toggle("info-open", detailsOpen);
    root.querySelector("#unitStrip .focus")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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

  function layout(ids) {
    const container = root.querySelector("#group");
    const strip = root.querySelector("#unitStrip");
    if (!container?.style || typeof window === "undefined") return;
    const bounds = reviewLayout(ids.length, container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight, viewMode, state().unitIndex, groupAspect(state(), ids));
    if (strip) strip.hidden = false;
    container.style.setProperty("--columns", String(bounds.columns));
    container.style.setProperty("--rows", String(bounds.rows));
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
    const groups = filteredGroups(viewState);
    return `第 ${(viewState.data?.page?.cursor || 0) + viewState.groupIndex + 1} / ${viewState.data?.page?.total || groups.length} 组`
      + ` · ${ids.length} 张`;
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
      aria-label="${escapeReason(item.name || `第 ${index + 1} 张`)}" aria-current="${index === viewState.unitIndex}">
      <img src="${preview}" loading="lazy" alt=""><span class="thumbnail-rank">${index + 1}</span>
      ${decisionBadge(decisionFor(viewState, unitId, group), group.hideAI)}</button>`;
  }

  function renderUnit(viewState, group, unitId, index, faceRows) {
    const unit = reviewIndex(viewState).units.get(unitId) || { id: unitId, formats: [] };
    const result = reviewIndex(viewState).results.get(unitId) || {};
    const ranking = group.ranking?.find(item => item.unitId === unitId) || {};
    const candidate = group.candidateSet?.entries?.find(item => item.unitId === unitId);
    const decision = decisionFor(viewState, unitId, group);
    const item = reviewIndex(viewState).items.get(unit.primaryItemId) || {};
    const preview = viewMode === "grid" ? `${viewState.base}/runs/${getRunId()}/preview/${encodeURIComponent(unitId)}`
      : displayUrl(viewState.base, getRunId(), unitId, 440, 340, globalThis.devicePixelRatio || 1);
    const flags = (result.flags || []).map(flag =>
      `<span class="badge" title="${flagLabels[flag] || flag}">
      ${flag === "eyes-closed" ? "◡" : "⚠"}</span>`).join("");
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
    const recommend = !group.hideAI && ranking.rank === 1 ? "<span class=\"recommend\">推荐</span>" : "";
    const decided = decisionBadge(decision, group.hideAI);
    const images = faceRows
      ? `<div class="face-column">${faceRows.map((row, rowIndex) =>
        (magnifier ? renderNativeFace(row[index], faceContext, magnifierRegion)
          : renderFace(row[index], faceContext, `位置 ${rowIndex + 1}`))).join("")}</div>`
      : `<div class="image-wrap" data-preview="${unitId}" title="双击看大图"><img src="${preview}" loading="lazy"
        alt="${escapeReason(item.name || "预览")}" draggable="false"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="placeholder">预览不可用</span>${decided}
        <span class="image-flags">${flags}</span></div>`;
    const name = item.name || "未命名文件";
    const legacyDetail = viewMode === 'grid' ? ''
      : ` data-detail-compat="${viewState.base}/runs/${getRunId()}/detail/${encodeURIComponent(unitId)}"`;
    return `<article class="unit ${focus} ${selected} ${decision.source === "human" ? `decided-${decision.action}` : ""}"
      data-unit-id="${unitId}"${legacyDetail}>
      ${faceRows ? `${recommend}<h3 title="${escapeReason(name)}">${escapeReason(name)}</h3>` : ""}${images}
      <div class="unit-info" ${!detailsOpen || index !== viewState.unitIndex ? "hidden" : ""}>
      <div class="unit-head">${faceRows ? "" : `<h3 title="${escapeReason(name)}">${escapeReason(name)}</h3>`}
        <span class="rank" ${group.hideAI ? "hidden" : ""}>#${ranking.rank ?? index + 1} ·
        <strong>${formatTotalScore(ranking.score ?? result.score)}</strong></span></div>
      <p class="unit-status">${group.hideAI ? "" : `建议 <strong class="${actionClass(group.suggested?.[unitId]
        || "candidate")}">${suggestion}</strong> · `}<strong class="${sourceClass} ${decision.source === "human"
        ? actionClass(decision.action) : "unconfirmed"}">${decision.source === "human" ? `已${current}` : "未确认"}</strong></p>
      ${faceRows || !detailsOpen || index !== viewState.unitIndex ? "" : renderFaceStrip(result, faceContext)}
      <details class="unit-details" ${detailsOpen ? "open" : ""}><summary>评分与理由</summary>
        <div class="metrics">${scoreBars}</div>
        <p class="reasons" ${group.hideAI ? "hidden" : ""}>
          ${escapeReason((ranking.reasons || []).join("；"))}${candidateText ? `；${escapeReason(candidateText)}` : ""}</p>
        ${renderRuleReasons(result, getCatalog())}
        <label>自由理由（最多 500 字符）<textarea data-decision-reason maxlength="500"
          aria-label="自由理由">${escapeReason(reasonDrafts.get(unitId) ?? decision.reason ?? "")}</textarea></label>
      </details></div>
      <div class="decision-buttons">${Object.entries(actionLabels).map(([action, label]) =>
        `<button data-action="${action}" title="${label}（${actionKeys[action]}）" aria-label="${label}">
          ${{ selected: '★', candidate: '○', rejected: '✕' }[action]}</button>`).join('')}
        <button data-tie="true" title="并列" aria-label="并列">≈</button>
        <button data-open-preview="${unitId}" title="看大图" aria-label="看大图">⤢</button></div>
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
    setState(reduceState(state(), { type: "unit", index: state().unitIndex }));
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
  root.querySelector("#group").addEventListener("toggle", event => {
    if (!event.target.matches?.(".unit-details") || event.target.open === detailsOpen) return;
    detailsOpen = event.target.open;
    root.querySelectorAll("#group .unit-details").forEach(element => { element.open = detailsOpen; });
    render();
  }, true);
  if (typeof window !== "undefined") {
    window.addEventListener?.("resize", () => {
      if (!root.querySelector("#review")?.hidden) render();
    });
  }
  root.querySelector("#group").addEventListener("input", event => {
    if (event.target.matches?.("[data-decision-reason]"))
      reasonDrafts.set(event.target.closest(".unit").dataset.unitId, event.target.value);
  });
  root.querySelector("#group").addEventListener("click", event => {
    const card = event.target.closest(".unit"); if (!card) return;
    if (event.target.closest("details, textarea, input")) return;
    if (event.target.closest("[data-open-preview]")) { onPreview?.(card.dataset.unitId); return; }
    const viewState = state(); const group = currentGroup(viewState);
    const ids = rankedUnitIds(group); const unitId = card.dataset.unitId;
    if (event.target.closest("[data-action]")) {
      onDecision(unitId, event.target.closest("[data-action]").dataset.action,
        { reason: card.querySelector("[data-decision-reason]")?.value.trim() || "" }); return;
    }
    if (event.target.closest("[data-tie]")) {
      onDecision(unitId, "candidate", { category: "candidate", tie: true, reason: "各有所长" }); return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      const selected = toggleSelection(viewState.selected, unitId, {
        range: event.shiftKey, orderedIds: ids
      });
      setState(reduceState(viewState, { type: "selection", selected }));
    }
    setState(reduceState(state(), { type: "unit", index: ids.indexOf(unitId) })); render();
  });
  root.querySelector("#group").addEventListener("dblclick", event => {
    const wrap = event.target.closest("[data-preview]");
    if (wrap && onPreview) onPreview(wrap.dataset.preview);
  });
  function closeNativeMagnifier() {
    if (!magnifier) return false;
    magnifier = false; render(); return true;
  }
  function decisionReason(unitId) {
    const card = [...(root.querySelectorAll("#group .unit") || [])].find(c => c.dataset.unitId === unitId);
    return card?.querySelector("[data-decision-reason]")?.value.trim();
  }
  function setViewMode(mode) {
    if (!['compare', 'single', 'grid'].includes(mode)) return;
    viewMode = mode;
    const review = root.querySelector('#review');
    if (review?.dataset) review.dataset.viewMode = mode;
    root.querySelectorAll?.('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === mode)));
    render();
  }
  function toggleInfo() { detailsOpen = !detailsOpen; render(); }
  root.querySelector('#toggleInfo')?.addEventListener('click', toggleInfo);
  root.querySelector('#toggleGroups')?.addEventListener('click', () => {
    sidebarOpen = !sidebarOpen;
    root.querySelector('#review')?.classList.toggle('sidebar-open', sidebarOpen);
    render();
  });
  root.querySelectorAll?.('[data-view]').forEach(button => button.addEventListener('click', () => setViewMode(button.dataset.view)));
  return { decisionReason, render, expose, toggleFaces, nativeAction, closeNativeMagnifier, setViewMode, toggleInfo };

}
