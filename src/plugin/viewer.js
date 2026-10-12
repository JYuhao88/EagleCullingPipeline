const MAX_SCALE = 8;
const NATIVE_DELAY = 250;
// Must not exceed MAX_REGION_AREA in src/server/focus-image.js.
const MAX_NATIVE_AREA = 0.36;
import { displayEdgeForViewport } from './display-url.js';

export const displayEdge = (stage, dpr = 1, zoom = 1) =>
  displayEdgeForViewport(stage.width, stage.height, dpr * Math.min(4, Math.max(1, zoom || 1)));
export function preserveDisplayGeometry(view, before, after) {
  return before?.width && after?.width ? { ...view, scale: view.scale * before.width / after.width } : view;
}

export function clampView(view, stage, image) {
  const width = image.width * view.scale, height = image.height * view.scale;
  const x = width <= stage.width ? (stage.width - width) / 2 : Math.min(0, Math.max(stage.width - width, view.x));
  const y = height <= stage.height ? (stage.height - height) / 2 : Math.min(0, Math.max(stage.height - height, view.y));
  return { scale: view.scale, x, y };
}

export function fitScale(stage, image) {
  if (!image.width || !image.height) return 1;
  return Math.min(stage.width / image.width, stage.height / image.height);
}

export function zoomAt(view, factor, point, stage, image) {
  const min = fitScale(stage, image);
  const scale = Math.min(MAX_SCALE, Math.max(min, view.scale * factor));
  const ratio = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, stage, image);
}

/** Visible region in normalized image coordinates, snapped outward so pans reuse cached native crops. */
export function visibleBox(view, stage, image, grid = 32) {
  const width = image.width * view.scale, height = image.height * view.scale;
  const raw = [-view.x / width, -view.y / height, (stage.width - view.x) / width, (stage.height - view.y) / height];
  const snap = (value, up) => Math.min(1, Math.max(0, (up ? Math.ceil : Math.floor)(value * grid) / grid));
  return [snap(raw[0], false), snap(raw[1], false), snap(raw[2], true), snap(raw[3], true)];
}

/** Demand covers the snapped crop, not only the viewport; dimensions are physical display pixels. */
export function regionDisplay(view, image, box, dpr = 1) {
  return { width: Math.ceil((box[2] - box[0]) * image.width * view.scale * dpr),
    height: Math.ceil((box[3] - box[1]) * image.height * view.scale * dpr) };
}

export function createViewer({ root, nativeUrl, prefetchUrl, displayUrl }) {
  const dialog = root.querySelector("#previewDialog");
  const stageElement = root.querySelector("#viewerStage");
  const image = root.querySelector("#previewImage");
  const native = root.querySelector("#viewerNative");
  const zoomLabel = root.querySelector("#viewerZoom");
  const nativeLabel = root.querySelector("#viewerNativeState");
  let nativeState = "";
  const setNativeState = value => {
    nativeState = value;
    if (nativeLabel) nativeLabel.textContent = value === "loading" ? "读取原图…" : value === "ready" ? "原图" : value === "mid" ? "高清缓存" : "";
  };
  let view = { scale: 1, x: 0, y: 0 };
  let natural = { width: 0, height: 0 };
  let unitId = null, drag = null, nativeTimer = null, nativeToken = 0, fitted = true, displayToken = 0;
  let displayObjectUrl = null, displayTimer = null;
  let displayRequestKey = null;

  let regionController = null, regionObjectUrl = null, requestKey = null;
  let prefetchController = null, neighbors = [];
  function cancelRegion() {
    clearTimeout(nativeTimer); nativeToken++; regionController?.abort(); regionController = null;
    requestKey = null;
  }
  function prefetch() {
    prefetchController?.abort();
    if (!prefetchUrl || !unitId) return;
    prefetchController = new AbortController();
    const signal = prefetchController.signal;
    const ids = [...new Set([unitId, ...neighbors])];
    (async () => {
      for (const id of ids) {
        if (signal.aborted) break;
        await fetch(prefetchUrl(id), { method: 'POST', signal });
      }
    })().catch(() => {});
  }
  const stage = () => ({ width: stageElement.clientWidth, height: stageElement.clientHeight });
  const apply = () => {
    image.style.width = `${natural.width}px`;
    image.style.height = `${natural.height}px`;
    image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const fit = fitScale(stage(), natural);
    if (zoomLabel) zoomLabel.textContent = fitted ? "适应窗口" : `${(view.scale / fit).toFixed(1)}×`;
    stageElement.classList.toggle("zoomed", !fitted);
    positionNative();
    scheduleNative();
    clearTimeout(displayTimer);
    displayTimer = setTimeout(requestDisplay, fitted ? 0 : NATIVE_DELAY);
  };
  function requestDisplay() {
    if (!displayUrl || !unitId || !natural.width || !dialog.open) return;
    const zoom = view.scale / (fitScale(stage(), natural) || view.scale || 1);
    const edge = displayEdge(stage(), window.devicePixelRatio || 1, zoom), key = `${unitId}:${edge}`;
    const previous = displayRequestKey?.startsWith(`${unitId}:`) ? Number(displayRequestKey.split(':').pop()) : 0;
    if (edge <= previous) return;
    const token = ++displayToken;
    displayRequestKey = key;
    fetch(displayUrl(unitId, edge)).then(response => { if (!response.ok) throw new Error('display unavailable');
      return response.blob().then(blob => ({ blob, response })); }).then(({ blob, response }) => new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob), next = new Image();
      next.onload = () => resolve({ objectUrl, next, response });
      next.onerror = () => reject(new Error('display image invalid')); next.src = objectUrl;
    })).then(({ objectUrl, next, response }) => {
      if (token !== displayToken || !unitId) return URL.revokeObjectURL(objectUrl);
      const before = natural, oldView = view;
      if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl);
      displayObjectUrl = objectUrl; image.src = objectUrl; natural = { width: next.naturalWidth, height: next.naturalHeight };
      if (fitted) fit(); else { view = preserveDisplayGeometry(oldView, before, natural); apply(); }
      const warning = response.headers.get('x-display-warning');
      const source = response.headers.get('x-display-source');
      if (nativeLabel && (warning || source === 'eagle-thumbnail')) {
        nativeLabel.textContent = `低清：${warning ? decodeURIComponent(warning) : 'Eagle 缩略图'}`;
      }
    }).catch(() => { if (token === displayToken) displayRequestKey = null; });
  }
  function fit() {
    fitted = true;
    view = clampView({ scale: fitScale(stage(), natural), x: 0, y: 0 }, stage(), natural);
    apply();
  }
  function setView(next) {
    view = next;
    fitted = view.scale <= fitScale(stage(), natural) * 1.001;
    apply();
  }
  function zoom(factor, point = { x: stage().width / 2, y: stage().height / 2 }) {
    if (!natural.width) return;
    setView(zoomAt(view, factor, point, stage(), natural));
  }
  function toggle(point) {
    const fitValue = fitScale(stage(), natural);
    if (!fitted) return fit();
    const target = Math.max(1, fitValue * 2.5);
    zoom(target / view.scale, point);
  }

  function positionNative() {
    if (native.hidden || !native.dataset.box) return;
    const [x0, y0, x1, y1] = native.dataset.box.split(",").map(Number);
    const width = natural.width * view.scale, height = natural.height * view.scale;
    Object.assign(native.style, { left: `${view.x + x0 * width}px`, top: `${view.y + y0 * height}px`,
      width: `${(x1 - x0) * width}px`, height: `${(y1 - y0) * height}px` });
  }
  function scheduleNative() {
    const box = nativeUrl && unitId && view.scale * (window.devicePixelRatio || 1) > 1.05 ? visibleBox(view, stage(), natural) : null;
    if (!box || (box[2] - box[0]) * (box[3] - box[1]) > MAX_NATIVE_AREA) {
      if (nativeState) { cancelRegion(); native.hidden = true; setNativeState(""); }
      return;
    }
    const display = regionDisplay(view, natural, box, window.devicePixelRatio || 1);
    const key = `${box.join(',')}:${display.width}:${display.height}`;
    if (requestKey === key) return;
    cancelRegion(); requestKey = key;
    setNativeState("loading");
    nativeTimer = setTimeout(async () => {
      const token = ++nativeToken;
      regionController = new AbortController();
      let objectUrl;
      try {
        const response = await fetch(nativeUrl(unitId, box, display), { signal: regionController.signal });
        if (!response.ok) throw new Error('region unavailable');
        const blob = await response.blob();
        if (token !== nativeToken) return;
        objectUrl = URL.createObjectURL(blob);
        const next = new Image();
        next.onload = () => {
          if (token !== nativeToken) { URL.revokeObjectURL(objectUrl); return; }
          if (regionObjectUrl) URL.revokeObjectURL(regionObjectUrl);
          regionObjectUrl = objectUrl;
          native.src = objectUrl; native.dataset.box = box.join(","); native.hidden = false; positionNative();
          setNativeState(response.headers.get('x-native-tier') === 'mid' ? 'mid' : 'ready');
        };
        next.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          if (token === nativeToken) { requestKey = null; setNativeState(''); }
        };
        next.src = objectUrl;
      } catch {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (token === nativeToken) { requestKey = null; setNativeState(''); }
      }
    }, NATIVE_DELAY);
  }

  function show(id, src, adjacent = []) {
    const changed = id !== unitId || image.src !== src;
    neighbors = adjacent;
    if (!changed) return;
    cancelRegion(); prefetchController?.abort(); displayToken++; displayRequestKey = null;
    unitId = id; native.hidden = true; delete native.dataset.box; setNativeState("");
    if (regionObjectUrl) URL.revokeObjectURL(regionObjectUrl);
    regionObjectUrl = null;
    if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl);
    displayObjectUrl = null;
    natural = { width: 0, height: 0 };
    image.onload = () => { natural = { width: image.naturalWidth, height: image.naturalHeight }; fit(); };
    image.src = src;
    if (dialog.open) prefetch();
  }

  function applyAdjustment(filter) { image.style.filter = filter || "none"; native.style.filter = filter || "none"; }

  function open() {
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.hidden = false;
    prefetch();
    requestAnimationFrame?.(() => natural.width && fit());
  }
  function close() {
    unitId = null; cancelRegion(); prefetchController?.abort(); displayToken++; displayRequestKey = null;
    native.hidden = true; setNativeState('');
    if (regionObjectUrl) URL.revokeObjectURL(regionObjectUrl);
    regionObjectUrl = null;
    if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl);
    displayObjectUrl = null;
    if (typeof dialog.close === "function") dialog.close(); else dialog.hidden = true;
  }

  dialog.addEventListener("close", () => { if (unitId) close(); });
  stageElement.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = stageElement.getBoundingClientRect();
    zoom(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  stageElement.addEventListener("pointerdown", event => {
    if (event.button !== 0 || fitted) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
    stageElement.setPointerCapture?.(event.pointerId);
    stageElement.classList.add("dragging");
  });
  stageElement.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    setView(clampView({ scale: drag.view.scale, x: drag.view.x + event.clientX - drag.x,
      y: drag.view.y + event.clientY - drag.y }, stage(), natural));
  });
  const endDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null; stageElement.classList.remove("dragging");
  };
  stageElement.addEventListener("pointerup", endDrag);
  stageElement.addEventListener("pointercancel", endDrag);
  stageElement.addEventListener("dblclick", event => {
    const rect = stageElement.getBoundingClientRect();
    toggle({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  });
  window.addEventListener("resize", () => {
    if (!dialog.open || !natural.width) return;
    if (fitted) fit(); else setView(clampView(view, stage(), natural));
  });

  function key(event) {
    if (event.key === "+" || event.key === "=") { zoom(1.25); return true; }
    if (event.key === "-" || event.key === "_") { zoom(0.8); return true; }
    if (event.key === "0") { fit(); return true; }
    if (event.key.toLowerCase() === "z") { toggle({ x: stage().width / 2, y: stage().height / 2 }); return true; }
    return false;
  }
  root.querySelector("#viewerZoomIn")?.addEventListener("click", () => zoom(1.25));
  root.querySelector("#viewerZoomOut")?.addEventListener("click", () => zoom(0.8));
  root.querySelector("#viewerFit")?.addEventListener("click", fit);
  return { show, open, close, key, fit, applyAdjustment, isOpen: () => Boolean(dialog.open || (!dialog.hidden && unitId)) };
}
