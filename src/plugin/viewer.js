import { createZoomStage } from './zoom-stage.js';

export { clampView, displayEdge, fitScale, preserveDisplayGeometry, regionDisplay, visibleBox, zoomAt } from './zoom-stage.js';

export function createViewer({ root, nativeUrl, prefetchUrl, displayUrl }) {
  const dialog = root.querySelector("#previewDialog");
  const stageElement = root.querySelector("#viewerStage");
  const zoomStage = createZoomStage({ stage: stageElement, image: root.querySelector("#previewImage"),
    native: root.querySelector("#viewerNative"), zoomLabel: root.querySelector("#viewerZoom"),
    nativeLabel: root.querySelector("#viewerNativeState"), nativeUrl, displayUrl, active: () => Boolean(dialog.open) });
  let unitId = null, prefetchController = null, neighbors = [];
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

  function show(id, src, adjacent = []) {
    neighbors = adjacent;
    if (!zoomStage.show(id, src)) return;
    prefetchController?.abort();
    unitId = id;
    if (dialog.open) prefetch();
  }

  function open() {
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.hidden = false;
    prefetch();
    requestAnimationFrame?.(() => zoomStage.hasImage() && zoomStage.fit());
  }
  function close() {
    unitId = null; prefetchController?.abort(); zoomStage.clear();
    if (typeof dialog.close === "function") dialog.close(); else dialog.hidden = true;
  }

  dialog.addEventListener("close", () => { if (unitId) close(); });
  window.addEventListener("resize", () => { if (dialog.open) zoomStage.refit(); });

  function key(event) {
    if (event.key === "+" || event.key === "=") { zoomStage.zoom(1.25); return true; }
    if (event.key === "-" || event.key === "_") { zoomStage.zoom(0.8); return true; }
    if (event.key === "0") { zoomStage.fit(); return true; }
    if (event.key.toLowerCase() === "z") { zoomStage.toggle(); return true; }
    return false;
  }
  root.querySelector("#viewerZoomIn")?.addEventListener("click", () => zoomStage.zoom(1.25));
  root.querySelector("#viewerZoomOut")?.addEventListener("click", () => zoomStage.zoom(0.8));
  root.querySelector("#viewerFit")?.addEventListener("click", () => zoomStage.fit());
  return { show, open, close, key, fit: () => zoomStage.fit(), applyAdjustment: zoomStage.applyAdjustment,
    isOpen: () => Boolean(dialog.open || (!dialog.hidden && unitId)) };
}
