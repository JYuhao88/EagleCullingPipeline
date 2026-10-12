const MAX_SCALE = 8;
const NATIVE_DELAY = 250;
// Must not exceed MAX_REGION_AREA in src/server/focus-image.js.
const MAX_NATIVE_AREA = 0.36;

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

export function createViewer({ root, nativeUrl }) {
  const dialog = root.querySelector("#previewDialog");
  const stageElement = root.querySelector("#viewerStage");
  const image = root.querySelector("#previewImage");
  const native = root.querySelector("#viewerNative");
  const zoomLabel = root.querySelector("#viewerZoom");
  let view = { scale: 1, x: 0, y: 0 };
  let natural = { width: 0, height: 0 };
  let unitId = null, drag = null, nativeTimer = null, nativeToken = 0, fitted = true;

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
  };
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
    clearTimeout(nativeTimer);
    if (!nativeUrl || view.scale <= 1.05 || !unitId) { native.hidden = true; return; }
    const box = visibleBox(view, stage(), natural);
    if ((box[2] - box[0]) * (box[3] - box[1]) > MAX_NATIVE_AREA) { native.hidden = true; return; }
    if (native.dataset.box === box.join(",") && !native.hidden) return;
    nativeTimer = setTimeout(() => {
      const token = ++nativeToken, next = new Image();
      next.onload = () => {
        if (token !== nativeToken) return;
        native.src = next.src; native.dataset.box = box.join(","); native.hidden = false; positionNative();
      };
      next.src = nativeUrl(unitId, box);
    }, NATIVE_DELAY);
  }

  function show(id, src) {
    const changed = id !== unitId;
    unitId = id; nativeToken++; native.hidden = true; delete native.dataset.box;
    if (!changed && image.src === src) return;
    natural = { width: 0, height: 0 };
    image.onload = () => { natural = { width: image.naturalWidth, height: image.naturalHeight }; fit(); };
    image.src = src;
  }
  function open() {
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.hidden = false;
    requestAnimationFrame?.(() => natural.width && fit());
  }
  function close() {
    unitId = null; nativeToken++; clearTimeout(nativeTimer);
    if (typeof dialog.close === "function") dialog.close(); else dialog.hidden = true;
  }

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
  return { show, open, close, key, fit, isOpen: () => Boolean(dialog.open || (!dialog.hidden && unitId)) };
}
