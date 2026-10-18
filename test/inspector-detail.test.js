import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentTables, toLinear, toSrgb, toneCurve, whiteBalanceGains } from '../src/plugin/adjust.js';
import { validateAdjustments } from '../src/server/adjustments-routes.js';
import { adjustmentLabel, autoExposure, clampExposure, createDetailView, exposureLabel, filterMarkup, focusAreaCentre, focusPoint,
  fromSlider, fullSizeZoom, luminance, peakingMask, placement, readDetailState, settle, sliderValue, zoomAround, zoomLabel }
  from '../src/plugin/inspector/inspector-detail.js';
import { orient, parseFocusPoints, readFocusPoints } from '../src/core/focus-points.js';

test('exposure is clamped to ±3 EV in tenth stops; sliders show EV and −100…+100', () => {
  assert.equal(clampExposure(4), 3); assert.equal(clampExposure(-9), -3); assert.equal(clampExposure('x'), 0);
  assert.equal(clampExposure(0.04), 0); assert.equal(clampExposure(1.26), 1.3);
  assert.equal(exposureLabel(0), '0 EV'); assert.equal(exposureLabel(0.7), '+0.7 EV'); assert.equal(exposureLabel(-1.5), '−1.5 EV');
  assert.equal(adjustmentLabel('contrast', 0.25), '+25'); assert.equal(adjustmentLabel('shadows', -0.4), '−40');
  assert.equal(adjustmentLabel('tint', 0), '0');
  assert.equal(sliderValue('exposure', 1.26), '1.3'); assert.equal(sliderValue('whites', -0.37), '-37');
  assert.equal(fromSlider('exposure', '9'), 3); assert.equal(fromSlider('blacks', '-150'), -1);
  assert.equal(fromSlider('saturation', '30'), 0.3);
});

test('exposure tables equal the exact linear-light gain for every 8-bit input, including the deep shadows', () => {
  for (const ev of [-3, -1, 1, 3]) {
    const table = adjustmentTables({ exposure: ev })[1];
    for (let i = 0; i < 256; i++) {
      const exact = toSrgb(Math.min(1, toLinear(i / 255) * 2 ** ev));
      assert.ok(Math.abs(table[i] - exact) < 1e-9, `${ev} EV at ${i}`);
    }
  }
  const lifted = adjustmentTables({ exposure: 1 })[0].slice(0, 64).map(v => Math.round(v * 255));
  assert.equal(new Set(lifted).size, 64, 'no two shadow levels merge at +1 EV');
  const identity = adjustmentTables({});
  assert.ok(identity.every(table => table.every((v, i) => Math.abs(v * 255 - i) < 1e-9)));
});

test('the tone curve never reverses, whatever the slider combination', () => {
  const values = [-1, -0.5, 0, 0.5, 1];
  for (const contrast of values) for (const highlights of values) for (const shadows of values)
    for (const whites of values) for (const blacks of values) {
      const settings = { contrast, highlights, shadows, whites, blacks };
      let last = -Infinity;
      for (let i = 0; i <= 256; i++) {
        const v = toneCurve(i / 256, settings);
        assert.ok(v >= last - 1e-12, JSON.stringify({ ...settings, at: i / 256 })); last = v;
      }
    }
});

test('tone controls act on their own range and keep the ends where Lightroom keeps them', () => {
  const at = (v, settings) => toneCurve(v, settings);
  assert.equal(at(0.5, { contrast: 1 }), 0.5, 'contrast pivots on the middle');
  assert.ok(at(0.25, { contrast: 1 }) < 0.25 && at(0.75, { contrast: 1 }) > 0.75);
  assert.ok(at(1 / 3, { shadows: 1 }) - 1 / 3 > 0.2 && Math.abs(at(0.9, { shadows: 1 }) - 0.9) < 0.03);
  assert.ok(2 / 3 - at(2 / 3, { highlights: -1 }) > 0.2 && Math.abs(at(0.1, { highlights: -1 }) - 0.1) < 0.03);
  assert.ok(at(0.05, { blacks: -1 }) === 0 && at(0, { blacks: 1 }) > 0.09);
  assert.ok(at(0.95, { whites: 1 }) === 1 && at(1, { whites: -1 }) < 0.91);
});

test('white balance tilts the channels and leaves the luminance of grey unchanged', () => {
  const [r, g, b] = whiteBalanceGains({ temperature: 1 });
  assert.ok(r > 1 && b < 1);
  assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 1e-12);
  const [, green] = whiteBalanceGains({ tint: 1 });
  assert.ok(green < 1, 'positive tint is magenta');
});

test('the filter markup carries three lookup tables and saturation only when it is set', () => {
  assert.doesNotMatch(filterMarkup({ exposure: 1 }), /feColorMatrix/);
  const markup = filterMarkup({ exposure: 1, saturation: -0.5 });
  assert.equal(markup.match(/type="table"/g).length, 3);
  assert.match(markup, /type="saturate" values="0.5"/);
  assert.equal(markup.match(/tableValues="([^"]*)"/)[1].split(' ').length, 256);
});

test('the server accepts every adjustment the view can save', () => {
  assert.deepEqual(validateAdjustments({ exposure: 1.3, whites: -0.2, blacks: 0.4, saturation: 0 }),
    { exposure: 1.3, whites: -0.2, blacks: 0.4 });
  assert.throws(() => validateAdjustments({ whites: 2 }), /whites/);
});

test('auto exposure moves the median linear luminance to middle grey', () => {
  assert.equal(autoExposure([]), 0);
  assert.equal(autoExposure(Array(9).fill(0.18)), 0);
  assert.equal(autoExposure(Array(9).fill(toLinear(0.2))), 2.4);
  assert.ok(autoExposure(Array(9).fill(0.8)) < 0);
  assert.equal(autoExposure(Array(9).fill(0)), 3);
  const red = luminance(255, 0, 0);
  assert.ok(Math.abs(red - 0.2126) < 1e-12, 'channels are decoded before weighting');
});

test('focus prefers the main subject face, then its head keypoints, then the centre', () => {
  const main = { box: [0.4, 0.1, 0.8, 0.9], main: true, points: [[0.6, 0.2, 0.9], [0.62, 0.19, 0.9]] };
  const marks = { persons: [{ box: [0, 0, 0.2, 0.5] }, main],
    faces: [{ box: [0.05, 0.05, 0.15, 0.15] }, { box: [0.5, 0.12, 0.7, 0.3] }] };
  assert.deepEqual(focusPoint(marks).map(v => +v.toFixed(3)), [0.6, 0.21]);
  assert.deepEqual(focusPoint({ persons: [main], faces: [{ box: [0, 0, 0.1, 0.1] }] }).map(v => +v.toFixed(3)), [0.61, 0.195]);
  assert.deepEqual(focusPoint(null), [0.5, 0.5]);
});

test('placement fits at zoom 1 and centres the focus when zoomed, never showing past the image edges', () => {
  const base = { frameWidth: 300, frameHeight: 300, imageWidth: 2000, imageHeight: 3000 };
  assert.deepEqual(placement({ ...base, zoom: 1 }), { scale: 0.1, width: 200, height: 300, x: 50, y: 0 });
  const zoomed = placement({ ...base, zoom: 4, focus: [0.5, 0.5] });
  assert.equal(zoomed.width, 800); assert.equal(zoomed.x, -250); assert.equal(zoomed.y, -450);
  const corner = placement({ ...base, zoom: 4, focus: [0, 1] });
  assert.equal(corner.x, 0); assert.equal(corner.y, 300 - 1200);
});

test('stored state falls back to safe defaults', () => {
  const storage = value => ({ getItem: () => value });
  assert.deepEqual(readDetailState(storage('{"ev":9,"zoom":3.5,"open":true,"peaking":true}')),
    { zoom: 3.5, open: true, marks: true, peaking: true });
  assert.deepEqual(readDetailState(storage('{"zoom":99,"marks":false}')), { zoom: 2, open: false, marks: false, peaking: false });
  assert.deepEqual(readDetailState(storage('nope')), { zoom: 2, open: false, marks: true, peaking: false });
});

test('wheel zoom keeps the point under the cursor still, and panning stops at the image edges', () => {
  const view = { frameWidth: 300, frameHeight: 300, imageWidth: 3000, imageHeight: 2000, zoom: 2, focus: [0.4, 0.5] };
  const under = (v, [px, py]) => { const at = placement(v); return [(px - at.x) / at.width, (py - at.y) / at.height]; };
  for (const point of [[60, 90], [150, 150], [290, 10]]) {
    const focus = zoomAround(view, 5, point), before = under(view, point), after = under({ ...view, zoom: 5, focus }, point);
    assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9, String(point));
  }
  assert.deepEqual(settle(view, [-3, 9]).map(v => +v.toFixed(4)), [0.25, 0.625], 'clamped where the edges stop it');
  assert.deepEqual(settle({ ...view, zoom: 1 }, [0.9, 0.1]), [0.5, 0.5]);
});

test('100 % is one photo pixel per device pixel, and the label reads 适应 / percent', () => {
  const geometry = { frameWidth: 300, frameHeight: 300, imageWidth: 3000, imageHeight: 2000 };
  assert.equal(fullSizeZoom({ ...geometry, sourceLongEdge: 6000, dpr: 2 }), 10);
  assert.equal(fullSizeZoom({ ...geometry, sourceLongEdge: 0 }), null);
  assert.equal(fullSizeZoom({ ...geometry, sourceLongEdge: 200 }), 1, 'never below the fitted view');
  assert.equal(zoomLabel(1, 10), '适应'); assert.equal(zoomLabel(5, 10), '50%'); assert.equal(zoomLabel(2.5, null), '2.5×');
});

test('focus areas centre on the in-focus one', () => {
  assert.deepEqual(focusAreaCentre([{ box: [0, 0, 0.2, 0.2] }, { box: [0.4, 0.4, 0.6, 0.8], inFocus: true }]).map(v => +v.toFixed(3)),
    [0.5, 0.6]);
  assert.equal(focusAreaCentre([]), null);
});

test('peaking marks a hard edge and ignores a smooth gradient', () => {
  const width = 8, height = 8, rgba = fill => Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => {
    const pixel = i >> 2, x = pixel % width; return i % 4 === 3 ? 255 : fill(x);
  });
  const edge = peakingMask(rgba(x => x < 4 ? 20 : 230), width, height);
  assert.equal(edge[3 * width + 3], 1); assert.equal(edge[3 * width + 1], 0);
  assert.ok(peakingMask(rgba(x => x * 12), width, height).every(v => v === 0));
});

test('camera focus points: Sony frame, Ricoh areas with their in-focus flag, all turned upright', () => {
  const sony = parseFocusPoints({ Orientation: 1, FocusLocation: '7008 4672 4270 2287', FocusFrameSize: '745 594 257' });
  assert.equal(sony.source, 'sony');
  assert.deepEqual(sony.areas, [{ box: [0.5562, 0.4259, 0.6625, 0.5531], kind: 'frame', inFocus: true }]);
  const point = parseFocusPoints({ FocusLocation: '7008 4672 3504 2336', FocusFrameSize: '0 0 0' }).areas[0];
  assert.equal(point.kind, 'point'); assert.ok(point.box[0] < 0.5 && point.box[2] > 0.5);
  const ricoh = parseFocusPoints({ Orientation: 6, AFAreas: '720 480 360 240 112 72 15 720 480 248 240 112 72 7' });
  assert.equal(ricoh.source, 'pentax');
  assert.deepEqual(ricoh.areas.map(area => area.inFocus), [true, false]);
  assert.deepEqual(ricoh.areas[0].box, [0.425, 0.4222, 0.575, 0.5778], 'the centre area stays centred after rotation');
  assert.deepEqual(parseFocusPoints({ Orientation: 1 }), { source: null, areas: [] }, 'cameras without focus data');
  assert.deepEqual(parseFocusPoints({ AFAreas: '720 480 900 240 112 72 15' }).areas, [], 'areas off the grid are dropped');
  assert.deepEqual(orient([0.1, 0.2], 6), [0.8, 0.1]); assert.deepEqual(orient([0.1, 0.2], 8), [0.2, 0.9]);
});

test('reading focus points without a file answers empty', async () => {
  assert.deepEqual(await readFocusPoints(''), { source: null, areas: [] });
});

function detailDom() {
  const node = (extra = {}) => ({ hidden: false, dataset: {}, style: {}, listeners: {}, textContent: '', value: '0', innerHTML: '',
    classList: { names: new Set(), toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); } },
    addEventListener(type, handler) { this.listeners[type] = handler; }, append() {}, ...extra });
  const ids = Object.fromEntries(['detailView', 'detailFrame', 'detailImage', 'ec-adjust', 'detailAdjusted', 'detailCopy',
    'detailAuto', 'detailReset'].map(id => [id, node()]));
  const rows = {}, outputs = {};
  const sliders = ['exposure', 'contrast', 'shadows'].map(name => {
    rows[name] = node(); outputs[name] = node();
    return node({ dataset: { adjust: name }, closest: () => rows[name] });
  });
  const html = node();
  const root = { documentElement: html, getElementById: id => ids[id],
    querySelectorAll: selector => selector === '[data-adjust]' ? sliders : [],
    querySelector: selector => outputs[selector.match(/data-adjust-value="(\w+)"/)?.[1]] };
  return { root, ids, rows, outputs, sliders, html };
}

test('each photo loads and saves its own adjustments, and they reach the compared pair too', async () => {
  const dom = detailDom(), calls = [], saved = { u1: { exposure: 1 } }, store = new Map();
  const timers = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    const unit = decodeURIComponent(url.split('/').pop());
    return { ok: true, json: async () => saved[unit] || {} };
  };
  const view = createDetailView({ root: dom.root, baseUrl: () => 'http://svc', fetchImpl, win: null,
    storage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    setTimer: fn => timers.push(fn), clearTimer: () => {} });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const runTimers = async () => { while (timers.length) timers.shift()(); await settle(); };

  view.render({ runId: 'r', unitId: 'u1' }); await settle();
  assert.equal(calls[0].url, 'http://svc/runs/r/adjustments/u1');
  assert.ok(dom.html.classList.names.has('ec-adjusted'), 'the pair and the crop share the filter');
  assert.equal(dom.sliders[0].value, '1'); assert.equal(dom.outputs.exposure.textContent, '+1.0 EV');
  assert.equal(dom.ids.detailAdjusted.hidden, false);
  assert.match(dom.ids['ec-adjust'].innerHTML, /tableValues/);

  dom.sliders[1].value = '25'; dom.sliders[1].listeners.input();
  await runTimers();
  assert.deepEqual(calls.at(-1), { url: 'http://svc/runs/r/adjustments/u1', method: 'PUT', body: { exposure: 1, contrast: 0.25 } });

  view.render({ runId: 'r', unitId: 'u2' }); await settle();
  assert.equal(dom.html.classList.names.has('ec-adjusted'), false, 'an unadjusted photo shows unfiltered');
  assert.equal(dom.ids.detailCopy.hidden, false, 'the previous photo’s values can be reused');
  dom.ids.detailCopy.listeners.click(); await runTimers();
  assert.deepEqual(calls.at(-1), { url: 'http://svc/runs/r/adjustments/u2', method: 'PUT', body: { exposure: 1, contrast: 0.25 } });

  dom.rows.contrast.listeners.dblclick(); await runTimers();
  assert.deepEqual(calls.at(-1).body, { exposure: 1 }, 'double-click resets one slider');
  dom.ids.detailReset.listeners.click(); await runTimers();
  assert.deepEqual(calls.at(-1).body, {}, '复位 clears the saved values');
  assert.equal(dom.html.classList.names.has('ec-adjusted'), false);
});
