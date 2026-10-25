import { displayUrl, displayEdgeForViewport } from '../display-url.js';
import { DEFAULT_ADJUSTMENTS, adjustmentTables, clampAdjustment, isNeutral, normalizeAdjustments, toLinear }
  from '../adjust.js';

// View-only adjustments on a zoomed crop and the compared pair next to Eagle's own preview; originals, scores and Eagle never
// change. Each photo's values are kept in its analysis record.
export const MAX_ZOOM = 32;
const RESOLUTION_STEPS = [1, 2, 4, 8, 16, 32];
const PEAK_THRESHOLD = 240;
const STORE_KEY = 'eagle-culling-detail';
const LAST_KEY = 'eagle-culling-detail-last';
const FILTER_ID = 'ec-adjust';
const SVG = 'http://www.w3.org/2000/svg';
const SAVE_DELAY_MS = 500;
const SHARPEN_DELAY_MS = 200;

export function clampExposure(value) {
  return Math.round(clampAdjustment('exposure', value) * 10) / 10 + 0;
}

export function exposureLabel(ev) {
  const value = clampExposure(ev);
  return value === 0 ? '0 EV' : `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} EV`;
}

export function adjustmentLabel(name, value) {
  if (name === 'exposure') return exposureLabel(value);
  const number = Math.round(clampAdjustment(name, value) * 100);
  return number === 0 ? '0' : `${number > 0 ? '+' : '−'}${Math.abs(number)}`;
}

// Sliders show exposure in EV and the rest as −100…+100, like Lightroom; stored values are EV and −1…1.
export const sliderValue = (name, value) => String(name === 'exposure' ? clampExposure(value) : Math.round(value * 100));
export const fromSlider = (name, text) => name === 'exposure' ? clampExposure(text) : clampAdjustment(name, Number(text) / 100);

// Linear luminance of an 8-bit sRGB pixel: each channel is decoded before the Rec. 709 weights apply.
export const luminance = (r, g, b) => 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);

// Puts the median linear luminance of what is visible on middle grey (18 %).
export function autoExposure(samples = []) {
  const values = samples.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 0;
  const median = Math.min(1, Math.max(0.0002, values[Math.floor(values.length / 2)]));
  return clampExposure(Math.log2(0.18 / median));
}

// The SVG filter for a set of adjustments: three lookup tables, then saturation, all on sRGB-encoded values.
export function filterMarkup(value) {
  const adjustments = normalizeAdjustments(value);
  const tables = adjustmentTables(adjustments).map(table => table.map(v => +v.toFixed(4)).join(' '));
  const saturation = 1 + (adjustments.saturation || 0);
  return `<feComponentTransfer><feFuncR type="table" tableValues="${tables[0]}"/><feFuncG type="table" tableValues="${tables[1]}"/>`
    + `<feFuncB type="table" tableValues="${tables[2]}"/></feComponentTransfer>`
    + (saturation === 1 ? '' : `<feColorMatrix type="saturate" values="${saturation}"/>`);
}

const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return w * h / Math.max(1e-9, (a[2] - a[0]) * (a[3] - a[1]));
};
const centre = box => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

// Default zoom target: the main subject's face, else the main subject's head keypoints, else the frame centre.
export function focusPoint(marks) {
  const main = (marks?.persons || []).find(person => person.main) || marks?.persons?.[0];
  const faces = (marks?.faces || []).filter(face => Array.isArray(face.box));
  const face = main ? faces.sort((a, b) => overlap(b.box, main.box) - overlap(a.box, main.box))[0] : faces[0];
  if (face && (!main || overlap(face.box, main.box) > 0.5)) return centre(face.box);
  const head = (main?.points || []).slice(0, 5).filter(point => point?.[2] >= 0.3);
  if (head.length) return [head.reduce((s, p) => s + p[0], 0) / head.length, head.reduce((s, p) => s + p[1], 0) / head.length];
  return [0.5, 0.5];
}

// Image placement inside a frame: contain-fit at zoom 1, then centred on the focus and clamped to the image edges.
export function placement({ frameWidth, frameHeight, imageWidth, imageHeight, zoom = 1, focus = [0.5, 0.5] }) {
  const fit = Math.min(frameWidth / imageWidth, frameHeight / imageHeight);
  const scale = fit * zoom, width = imageWidth * scale, height = imageHeight * scale;
  const axis = (frame, size, at) => size <= frame ? (frame - size) / 2 : Math.min(0, Math.max(frame - size, frame / 2 - at * size));
  return { scale, width, height, x: axis(frameWidth, width, focus[0]), y: axis(frameHeight, height, focus[1]) };
}

// The focus placement really shows once clamped to the edges, so a pan back never has to cross a dead zone first.
export function settle(view, focus) {
  const at = placement({ ...view, focus });
  return [(view.frameWidth / 2 - at.x) / at.width, (view.frameHeight / 2 - at.y) / at.height];
}

// The focus that keeps the image point under [px, py] (frame pixels) in place while the zoom changes.
export function zoomAround(view, zoom, [px, py]) {
  const before = placement(view), after = placement({ ...view, zoom });
  const ux = (px - before.x) / before.width, uy = (py - before.y) / before.height;
  return settle({ ...view, zoom }, [ux - (px - view.frameWidth / 2) / after.width, uy - (py - view.frameHeight / 2) / after.height]);
}

// The zoom at which one pixel of the original photo meets one device pixel.
export function fullSizeZoom({ frameWidth, frameHeight, imageWidth, imageHeight, sourceLongEdge, dpr = 1 }) {
  if (!(sourceLongEdge > 0) || !imageWidth || !imageHeight) return null;
  const fit = placement({ frameWidth, frameHeight, imageWidth, imageHeight });
  return Math.min(MAX_ZOOM, Math.max(1, sourceLongEdge / (Math.max(fit.width, fit.height) * dpr)));
}

export function zoomLabel(zoom, full) {
  if (zoom <= 1.001) return '适应';
  return full ? `${Math.round(zoom / full * 100)}%` : `${zoom.toFixed(1)}×`;
}

export function focusAreaCentre(areas = []) {
  const area = areas.find(item => item.inFocus) || areas[0];
  return area ? centre(area.box) : null;
}

// Focus peaking: pixels whose Sobel gradient on luminance passes the threshold, as seen at the current display size.
export function peakingMask(data, width, height, threshold = PEAK_THRESHOLD) {
  const grey = new Float32Array(width * height), mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, a = grey[i - width - 1], b = grey[i - width], c = grey[i - width + 1];
    const d = grey[i - 1], f = grey[i + 1], g = grey[i + width - 1], h = grey[i + width], k = grey[i + width + 1];
    const gx = c + 2 * f + k - a - 2 * d - g, gy = g + 2 * h + k - a - 2 * b - c;
    if (Math.abs(gx) + Math.abs(gy) >= threshold) mask[i] = 1;
  }
  return mask;
}

export function readDetailState(storage) {
  const fallback = { zoom: 2, open: false, marks: true, peaking: false };
  try {
    const value = JSON.parse(storage?.getItem(STORE_KEY) || '{}');
    const zoom = Number(value.zoom);
    return { zoom: zoom >= 1 && zoom <= MAX_ZOOM ? zoom : 2, open: value.open === true, marks: value.marks !== false,
      peaking: value.peaking === true };
  } catch { return fallback; }
}

export function createDetailView({ root = globalThis.document, storage = globalThis.localStorage, baseUrl, fetchImpl = globalThis.fetch,
  win = globalThis.window, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const el = id => root.getElementById?.(id);
  const fold = el('detailView'), frame = el('detailFrame'), image = el('detailImage');
  if (!fold || !frame || !image) return { render() {} };
  const sliders = [...root.querySelectorAll?.('[data-adjust]') || []];
  const marksLayer = el('detailMarks'), peakCanvas = el('detailPeaking'), zoomButton = el('detailZoomLabel');
  const marksToggle = el('detailMarksOn'), peakToggle = el('detailPeakingOn'), focusNote = el('detailFocusNote');
  let state = readDetailState(storage), current = null, focus = [0.5, 0.5], moved = false;
  let adjustments = {}, loadToken = 0, loaded = false, pending = null, saveTimer = null;
  let focusPoints = null, pointsFor = null, resolution = 1, sharpenTimer = null, peakQueued = false, drag = null;
  const readLast = () => { try { return normalizeAdjustments(JSON.parse(storage?.getItem(LAST_KEY) || '{}')); } catch { return {}; } };
  let previous = readLast();
  const save = () => storage?.setItem(STORE_KEY, JSON.stringify(state));
  // An analyzed photo is addressed by its run and unit; one not analyzed yet by its Eagle item in the library.
  const runUrl = (kind, { runId, unitId, itemId, libraryPath }) => itemId
    ? `${baseUrl()}/items/${encodeURIComponent(itemId)}/${kind}?libraryPath=${encodeURIComponent(libraryPath)}`
    : `${baseUrl()}/runs/${encodeURIComponent(runId)}/${kind}/${encodeURIComponent(unitId)}`;
  const view = () => ({ frameWidth: frame.clientWidth, frameHeight: frame.clientHeight, imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight, zoom: state.zoom, focus });
  const fullZoom = () => image.naturalWidth && fullSizeZoom({ ...view(), dpr: win?.devicePixelRatio || 1,
    sourceLongEdge: Math.max(focusPoints?.width || 0, focusPoints?.height || 0) });
  fold.open = state.open;
  ensureFilter();

  function ensureFilter() {
    if (el(FILTER_ID) || !root.createElementNS) return;
    const svg = root.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="${FILTER_ID}" color-interpolation-filters="sRGB"></filter>`;
    fold.append(svg);
  }
  function applyAdjustments() {
    const neutral = isNeutral(adjustments);
    const filter = el(FILTER_ID);
    if (filter && !neutral) filter.innerHTML = filterMarkup(adjustments);
    root.documentElement?.classList?.toggle('ec-adjusted', !neutral);
    for (const slider of sliders) {
      const name = slider.dataset.adjust, value = adjustments[name] || 0;
      slider.value = sliderValue(name, value);
      slider.closest?.('.adjust-row')?.classList.toggle('changed', value !== 0);
      const output = root.querySelector?.(`[data-adjust-value="${name}"]`);
      if (output) output.textContent = adjustmentLabel(name, value);
    }
    const badge = el('detailAdjusted'); if (badge) badge.hidden = neutral;
    const copy = el('detailCopy'); if (copy) copy.hidden = !loaded || !neutral || isNeutral(previous);
  }
  async function flush() {
    clearTimer(saveTimer); saveTimer = null;
    const job = pending; pending = null;
    if (!job) return;
    try {
      await fetchImpl(runUrl('adjustments', job), { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job.values), keepalive: true });
    } catch { /* the view keeps the values; the next change retries */ }
  }
  function change(next) {
    adjustments = normalizeAdjustments(next);
    loadToken++; loaded = true;
    if (!isNeutral(adjustments)) storage?.setItem(LAST_KEY, JSON.stringify(adjustments));
    applyAdjustments();
    if (!current) return;
    pending = { ...current, values: adjustments };
    clearTimer(saveTimer); saveTimer = setTimer(() => void flush(), SAVE_DELAY_MS);
  }
  async function loadAdjustments(unit) {
    const token = ++loadToken;
    loaded = false;
    let value = {};
    try {
      const response = await fetchImpl(runUrl('adjustments', unit));
      if (response.ok) value = await response.json();
    } catch { /* an older service without adjustments shows the photo unadjusted */ }
    if (token === loadToken) { adjustments = normalizeAdjustments(value); loaded = true; applyAdjustments(); }
  }
  async function loadFocusPoints() {
    if (!current || !fold.open || pointsFor === current.key) return;
    const unit = current; pointsFor = unit.key;
    let value = null;
    try {
      const response = await fetchImpl(runUrl('focus-points', unit));
      if (response.ok) value = await response.json();
    } catch { /* an older service has no focus points; the view works without them */ }
    if (current?.key !== unit.key) return;
    focusPoints = value;
    const af = focusAreaCentre(value?.areas);
    if (af && !moved) focus = af;
    renderMarks(); layout();
  }
  function renderMarks() {
    const areas = focusPoints?.areas || [];
    if (marksLayer) {
      marksLayer.hidden = !state.marks || !areas.length;
      marksLayer.innerHTML = areas.map(({ box, inFocus }) => `<i class="af${inFocus ? ' in-focus' : ''}" style="left:${box[0] * 100}%;`
        + `top:${box[1] * 100}%;width:${(box[2] - box[0]) * 100}%;height:${(box[3] - box[1]) * 100}%"></i>`).join('');
    }
    if (marksToggle) { marksToggle.setAttribute?.('aria-pressed', String(state.marks)); marksToggle.disabled = !areas.length; }
    if (peakToggle) peakToggle.setAttribute?.('aria-pressed', String(state.peaking));
    if (focusNote) focusNote.textContent = focusPoints && !areas.length ? '这台相机没有记录对焦点' : '';
  }
  function layout() {
    if (!image.naturalWidth || !frame.clientWidth) return;
    const at = placement(view());
    for (const node of [image, marksLayer].filter(Boolean)) {
      node.style.width = `${at.width}px`; node.style.height = `${at.height}px`;
      node.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
    if (zoomButton) zoomButton.textContent = zoomLabel(state.zoom, fullZoom());
    frame.classList.toggle('zoomed', state.zoom > 1.001);
    queuePeaking();
  }
  function load() {
    if (!current || !fold.open) return;
    void loadFocusPoints();
    const width = frame.clientWidth || 300, height = frame.clientHeight || 300;
    const src = current.itemId
      ? `${runUrl('display', current)}&edge=${displayEdgeForViewport(width * resolution, height * resolution, win?.devicePixelRatio || 1)}`
      : displayUrl(baseUrl(), current.runId, current.unitId, width * resolution, height * resolution, win?.devicePixelRatio || 1);
    if (image.dataset.src !== src) { image.crossOrigin = 'anonymous'; image.dataset.src = src; image.src = src; }
    else layout();
  }
  // A sharper file is fetched once the zoom settles past what the loaded one can show; zooming out keeps it.
  function sharpenLater() {
    const step = RESOLUTION_STEPS.find(value => value >= state.zoom) || MAX_ZOOM;
    if (step <= resolution) return;
    clearTimer(sharpenTimer);
    sharpenTimer = setTimer(() => { resolution = Math.max(resolution, step); load(); }, SHARPEN_DELAY_MS);
  }
  function zoomTo(next, point = [frame.clientWidth / 2, frame.clientHeight / 2]) {
    if (!image.naturalWidth) return;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, next));
    focus = zoomAround(view(), zoom, point);
    state.zoom = zoom; moved = true; save(); layout(); sharpenLater();
  }
  function queuePeaking() {
    if (peakQueued) return;
    peakQueued = true;
    (win?.requestAnimationFrame?.bind(win) || (fn => setTimer(fn, 16)))(drawPeaking);
  }
  function drawPeaking() {
    peakQueued = false;
    if (!peakCanvas) return;
    peakCanvas.hidden = !state.peaking || !image.naturalWidth || !fold.open;
    if (peakCanvas.hidden) return;
    const ratio = Math.min(2, win?.devicePixelRatio || 1), at = placement(view());
    const width = Math.round(frame.clientWidth * ratio), height = Math.round(frame.clientHeight * ratio);
    peakCanvas.width = width; peakCanvas.height = height;
    const context = peakCanvas.getContext('2d', { willReadFrequently: true });
    try {
      context.drawImage(image, at.x * ratio, at.y * ratio, at.width * ratio, at.height * ratio);
      const pixels = context.getImageData(0, 0, width, height), mask = peakingMask(pixels.data, width, height);
      for (let j = 0, i = 0; j < mask.length; j++, i += 4) {
        if (mask[j]) { pixels.data[i] = 255; pixels.data[i + 1] = 40; pixels.data[i + 2] = 40; pixels.data[i + 3] = 255; }
        else pixels.data[i + 3] = 0;
      }
      context.putImageData(pixels, 0, 0);
    } catch { peakCanvas.hidden = true; }
  }
  // Meters the unfiltered image, so the result is an absolute exposure rather than a step from the current one.
  function meter() {
    if (!image.naturalWidth) return;
    const canvas = root.createElement('canvas'), size = 96;
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const at = placement(view());
    const sx = Math.max(0, -at.x / at.scale), sy = Math.max(0, -at.y / at.scale);
    const sw = Math.min(image.naturalWidth - sx, frame.clientWidth / at.scale);
    const sh = Math.min(image.naturalHeight - sy, frame.clientHeight / at.scale);
    try {
      context.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
      const data = context.getImageData(0, 0, size, size).data, samples = [];
      for (let i = 0; i < data.length; i += 4) samples.push(luminance(data[i], data[i + 1], data[i + 2]));
      change({ ...adjustments, exposure: autoExposure(samples) });
    } catch { /* a tainted canvas only disables 自动曝光 */ }
  }
  const framePoint = event => {
    const rect = frame.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  image.addEventListener('load', layout);
  for (const slider of sliders) {
    const name = slider.dataset.adjust;
    slider.addEventListener('input', () => change({ ...adjustments, [name]: fromSlider(name, slider.value) }));
    slider.closest?.('.adjust-row')?.addEventListener('dblclick', () => change({ ...adjustments, [name]: DEFAULT_ADJUSTMENTS[name] }));
  }
  el('detailAuto')?.addEventListener('click', meter);
  el('detailReset')?.addEventListener('click', () => change({}));
  el('detailCopy')?.addEventListener('click', () => { if (previous) change(previous); });
  // Pinch arrives as a wheel event with ctrlKey and small steps. At the fitted view, scrolling down still scrolls the panel.
  frame.addEventListener('wheel', event => {
    if (!image.naturalWidth || (state.zoom <= 1 && event.deltaY > 0)) return;
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomTo(state.zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), framePoint(event));
  }, { passive: false });
  frame.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.zoom <= 1 || event.target === zoomButton) return;
    drag = { x: event.clientX, y: event.clientY, focus };
    frame.setPointerCapture?.(event.pointerId); frame.classList.add('dragging');
  });
  frame.addEventListener('pointermove', event => {
    if (!drag) return;
    const at = placement(view());
    focus = settle(view(), [drag.focus[0] - (event.clientX - drag.x) / at.width, drag.focus[1] - (event.clientY - drag.y) / at.height]);
    moved = true; layout();
  });
  const endDrag = () => { drag = null; frame.classList.remove('dragging'); };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
  frame.addEventListener('dblclick', event => {
    if (event.target === zoomButton) return;
    if (state.zoom > 1.001) zoomTo(1); else zoomTo(fullZoom() || 4, framePoint(event));
  });
  zoomButton?.addEventListener('click', () => zoomTo(1));
  marksToggle?.addEventListener('click', () => { state.marks = !state.marks; save(); renderMarks(); });
  peakToggle?.addEventListener('click', () => { state.peaking = !state.peaking; save(); renderMarks(); queuePeaking(); });
  fold.addEventListener('toggle', () => { state.open = fold.open; save(); load(); queuePeaking(); });
  // Eagle may rebuild the inspector page when the selection changes; a change still waiting to save goes out first.
  win?.addEventListener?.('pagehide', () => void flush());

  return {
    render(result) {
      const next = result?.runId && result?.unitId ? { runId: result.runId, unitId: result.unitId, key: `${result.runId}/${result.unitId}` }
        : result?.itemId && result?.libraryPath ? { itemId: result.itemId, libraryPath: result.libraryPath,
          key: `${result.libraryPath}/${result.itemId}` } : null;
      fold.hidden = !next;
      if (current && current.key !== next?.key) {
        void flush();
        previous = readLast();
        adjustments = {}; loadToken++;
        if (next) void loadAdjustments(next);
      } else if (!current && next) void loadAdjustments(next);
      if (!next) { current = null; applyAdjustments(); return; }
      if (current?.key !== next.key) {
        const member = (result.groupMembers || []).find(row => row.unitId === result.unitId);
        focus = focusPoint(member?.marks || result.marks); moved = false;
        focusPoints = null; pointsFor = null; resolution = Math.max(1, RESOLUTION_STEPS.find(value => value >= state.zoom) || 1);
      }
      current = next;
      renderMarks(); applyAdjustments(); load();
    },
  };
}
