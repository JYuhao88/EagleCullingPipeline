import { displayUrl } from '../display-url.js';

// View-only exposure on a zoomed crop next to Eagle's own preview; originals, scores and Eagle never change.
export const EXPOSURE_RANGE = Object.freeze([-3, 3]);
export const ZOOMS = Object.freeze([1, 2, 4]);
const STORE_KEY = 'eagle-culling-detail';
const FILTER_ID = 'ec-exposure';
const SVG = 'http://www.w3.org/2000/svg';

export function clampExposure(value) {
  const number = Number(value);
  return Math.round(Math.min(EXPOSURE_RANGE[1], Math.max(EXPOSURE_RANGE[0], Number.isFinite(number) ? number : 0)) * 10) / 10 + 0;
}

export function exposureLabel(ev) {
  const value = clampExposure(ev);
  return value === 0 ? '0 EV' : `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} EV`;
}

// Exposure is a gain on linear light, so one stop doubles the linear value regardless of the sRGB encoding.
export function exposureSlope(ev) { return Number((2 ** clampExposure(ev)).toFixed(4)); }

const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

// Puts the median luminance of what is visible on middle grey (18 % linear).
export function autoExposure(samples = []) {
  const values = samples.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 0;
  const median = toLinear(Math.min(1, Math.max(0.002, values[Math.floor(values.length / 2)])));
  return clampExposure(Math.log2(0.18 / median));
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

export function readDetailState(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORE_KEY) || '{}');
    return { ev: clampExposure(value.ev), zoom: ZOOMS.includes(value.zoom) ? value.zoom : 2, open: value.open === true };
  } catch { return { ev: 0, zoom: 2, open: false }; }
}

export function createDetailView({ root = globalThis.document, storage = globalThis.localStorage, baseUrl, win = globalThis.window }) {
  const el = id => root.getElementById?.(id);
  const fold = el('detailView'), frame = el('detailFrame'), image = el('detailImage');
  const slider = el('detailExposure'), output = el('detailEv');
  if (!fold || !frame || !image || !slider) return { render() {} };
  let state = readDetailState(storage), current = null, focus = [0.5, 0.5];
  const save = () => storage?.setItem(STORE_KEY, JSON.stringify(state));
  fold.open = state.open;
  ensureFilter();

  function ensureFilter() {
    if (el(FILTER_ID) || !root.createElementNS) return;
    const svg = root.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="${FILTER_ID}" color-interpolation-filters="linearRGB"><feComponentTransfer>`
      + '<feFuncR type="linear" slope="1"/><feFuncG type="linear" slope="1"/><feFuncB type="linear" slope="1"/>'
      + '</feComponentTransfer></filter>';
    fold.append(svg);
  }
  function applyExposure() {
    const slope = String(exposureSlope(state.ev));
    for (const node of el(FILTER_ID)?.querySelectorAll?.('feFuncR, feFuncG, feFuncB') || []) node.setAttribute('slope', slope);
    image.style.filter = state.ev === 0 ? '' : `url(#${FILTER_ID})`;
    slider.value = String(state.ev);
    if (output) output.textContent = exposureLabel(state.ev);
  }
  function layout() {
    if (!image.naturalWidth || !frame.clientWidth) return;
    const at = placement({ frameWidth: frame.clientWidth, frameHeight: frame.clientHeight, imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight, zoom: state.zoom, focus });
    image.style.width = `${at.width}px`; image.style.height = `${at.height}px`;
    image.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }
  function load() {
    if (!current || !fold.open) return;
    const width = frame.clientWidth || 300, height = frame.clientHeight || 300;
    const url = displayUrl(baseUrl(), current.runId, current.unitId, width * state.zoom, height * state.zoom, win?.devicePixelRatio || 1);
    if (image.dataset.src !== url) { image.crossOrigin = 'anonymous'; image.dataset.src = url; image.src = url; }
    else layout();
  }
  function renderZoom() {
    for (const button of root.querySelectorAll?.('[data-detail-zoom]') || [])
      button.classList.toggle('active', Number(button.dataset.detailZoom) === state.zoom);
  }
  function meter() {
    if (!image.naturalWidth) return;
    const canvas = root.createElement('canvas'), size = 96;
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const at = placement({ frameWidth: frame.clientWidth, frameHeight: frame.clientHeight, imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight, zoom: state.zoom, focus });
    const sx = Math.max(0, -at.x / at.scale), sy = Math.max(0, -at.y / at.scale);
    const sw = Math.min(image.naturalWidth - sx, frame.clientWidth / at.scale);
    const sh = Math.min(image.naturalHeight - sy, frame.clientHeight / at.scale);
    try {
      context.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
      const data = context.getImageData(0, 0, size, size).data, samples = [];
      for (let i = 0; i < data.length; i += 4) samples.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
      state.ev = autoExposure(samples); save(); applyExposure();
    } catch { /* a tainted canvas only disables 自动 */ }
  }

  image.addEventListener('load', layout);
  slider.addEventListener('input', () => { state.ev = clampExposure(slider.value); save(); applyExposure(); });
  el('detailAuto')?.addEventListener('click', meter);
  el('detailReset')?.addEventListener('click', () => { state.ev = 0; save(); applyExposure(); });
  for (const button of root.querySelectorAll?.('[data-detail-zoom]') || []) button.addEventListener('click', () => {
    state.zoom = Number(button.dataset.detailZoom); save(); renderZoom(); load();
  });
  frame.addEventListener('click', event => {
    if (!image.naturalWidth) return;
    const rect = image.getBoundingClientRect();
    const unit = value => Math.min(1, Math.max(0, value));
    focus = [unit((event.clientX - rect.left) / rect.width), unit((event.clientY - rect.top) / rect.height)];
    if (state.zoom === 1) { state.zoom = 2; save(); renderZoom(); load(); } else layout();
  });
  fold.addEventListener('toggle', () => { state.open = fold.open; save(); load(); });

  return {
    render(result) {
      fold.hidden = !result?.runId || !result?.unitId;
      if (fold.hidden) { current = null; return; }
      const member = (result.groupMembers || []).find(row => row.unitId === result.unitId);
      if (current?.unitId !== result.unitId) focus = focusPoint(member?.marks || result.marks);
      current = { runId: result.runId, unitId: result.unitId };
      renderZoom(); applyExposure(); load();
    },
  };
}
