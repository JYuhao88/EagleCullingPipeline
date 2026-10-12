import test from "node:test";
import assert from "node:assert/strict";
import { alignFaces, indexedFaces, largestFaces, renderFace, renderFaceStrip } from "../src/plugin/face-view.js";
import { createReviewView } from "../src/plugin/review-view.js";
import { keyboardAction } from "../src/plugin/keyboard.js";
import { initialState, reduceState } from "../src/plugin/state.js";

const face = (x, y = 0.2, size = 0.1) => ({
  box: [x, y, x + size, y + size], eyesAssessed: true, eyesClosed: false
});
const context = { base: "http://localhost", runId: "run-test", unitId: "unit:a" };

test("alignment matches positions across reordered detections and keeps original indices", () => {
  const results = [{ faces: [face(0.1), face(0.7)] }, { faces: [face(0.71), face(0.11)] }];
  const rows = alignFaces(results);
  assert.deepEqual(rows.map(row => row.map(cell => cell.index)), [[0, 1], [1, 0]]);
  assert.deepEqual(results[1].faces[0].box, face(0.71).box);
});

test("alignment leaves absent and distant faces blank, including an empty reference photo", () => {
  const rows = alignFaces([{}, { faces: [face(0.1), face(0.7)] }, { faces: [face(0.11), face(0.4, 0.7)] }]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row[0] === null));
  assert.deepEqual(rows[0].map(cell => cell?.index ?? null), [null, 0, 0]);
  assert.deepEqual(rows[1].map(cell => cell?.index ?? null), [null, null, 1]);
  assert.deepEqual(rows[2].map(cell => cell?.index ?? null), [null, 1, null]);
});

test("alignment assigns a face only once and chooses the closest pair first", () => {
  const rows = alignFaces([{ faces: [face(0.1), face(0.2)] }, { faces: [face(0.18)] }]);
  assert.equal(rows[0][1], null);
  assert.equal(rows[1][1].index, 0);
});

test("face strip orders by area and limits to four without changing endpoint indices", () => {
  const result = { faces: [face(0.1, 0.2, 0.2), face(0.1, 0.2, 0.3), face(0.1, 0.2, 0.15), face(0.2), face(0.4, 0.2, 0.05)] };
  assert.deepEqual(largestFaces(result).map(item => item.index), [1, 0, 2, 3]);
  const html = renderFaceStrip(result, context);
  assert.equal((html.match(/<figure/g) || []).length, 4);
  assert.match(html, /face\/unit%3Aa\/1/);
  assert.match(renderFace({ ...face(0.1), index: 0, eyesClosed: true }, context), /face-closed/);
  const unknown = renderFace({ ...face(0.1), index: 0, eyesClosed: true, eyesAssessed: false }, context);
  assert.match(unknown, /face-unknown/);
  assert.match(unknown, /未评估/);
});

test("old or invalid face data renders safely", () => {
  assert.deepEqual(alignFaces([]), []);
  assert.deepEqual(alignFaces([{}, { faces: null }]), []);
  assert.deepEqual(indexedFaces({ faces: [null, { box: [0, 0, 0, 0] }, { box: [-1, 0, 0.2, 0.2] }] }), []);
  assert.equal(renderFaceStrip({}, context), "");
});

function reviewFixture(results, { cards = [], onExposure = () => {} } = {}) {
  const nodes = new Map();
  const root = { querySelector: selector => {
    if (selector.includes(" .focus")) return null;
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: "", textContent: "", hidden: false, classList: { toggle() {} },
      setAttribute() {}, addEventListener() {}
    });
    return nodes.get(selector);
  }, querySelectorAll: selector => selector === "#group .unit" ? cards : [] };
  let state = { ...initialState, data: {
    units: [], items: [], results,
    groups: [{ id: "g", unitIds: results.map(item => item.unitId), ranking: [], suggested: {} }]
  } };
  const view = createReviewView({ root, state: () => state, setState: next => { state = next; }, runId: "run-test", onExposure });
  return { view, nodes, state: () => state };
}

test("exposure tracks viewport changes and waits for ordered pending persistence before decisions", async t => {
  const oldWindow = globalThis.window;
  globalThis.window = { innerWidth: 100, innerHeight: 100 };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  let offset = 0, release;
  const pending = new Promise(resolve => { release = resolve; }), exposures = [];
  const cards = ['a', 'b'].map((id, index) => ({ dataset: { unitId: id },
    getBoundingClientRect: () => ({ top: 0, bottom: 90, left: index * 200 - offset, right: index * 200 - offset + 90 }) }));
  const fixture = reviewFixture([{ unitId: 'a' }, { unitId: 'b' }], { cards,
    onExposure: event => { exposures.push(event); return exposures.length === 1 ? pending : Promise.resolve(); } });
  fixture.view.render();
  await Promise.resolve();
  assert.deepEqual(exposures[0].viewport, ['a']);
  offset = 200;
  const latest = fixture.view.expose();
  assert.equal(fixture.view.expose(), latest);
  assert.equal(exposures.length, 1);
  release(); await latest;
  assert.deepEqual(exposures.map(e => e.viewport), [['a'], ['b']]);
  assert.deepEqual(exposures[1].order, ['a', 'b']);
  assert.equal(exposures[1].aiVisible, true);
});

test("review cards tolerate missing faces and hide the group comparison button", () => {
  const fixture = reviewFixture([{ unitId: "unit:a", metrics: {} }]);
  assert.doesNotThrow(() => fixture.view.render());
  assert.equal(fixture.nodes.get("#compareFaces").hidden, true);
  assert.doesNotMatch(fixture.nodes.get("#group").innerHTML, /face-strip/);
  fixture.view.toggleFaces();
  assert.equal(fixture.state().faceCompare, false);
});

test('large groups request detail images only for the visible compare page and single focus', () => {
  const fixture = reviewFixture(Array.from({ length: 40 }, (_, index) => ({ unitId: `unit:${index}` })));
  fixture.view.render();
  assert.equal((fixture.nodes.get('#group').innerHTML.match(/class="unit /g) || []).length, 8);
  assert.equal((fixture.nodes.get('#group').innerHTML.match(/\/detail\//g) || []).length, 8);
  assert.equal((fixture.nodes.get('#unitStrip').innerHTML.match(/\/preview\//g) || []).length, 40);
  assert.match(fixture.nodes.get('#unitStrip').innerHTML, /loading="lazy"/);
  assert.equal(fixture.nodes.get('#groupList').innerHTML, '');
  fixture.view.setViewMode('single');
  assert.equal((fixture.nodes.get('#group').innerHTML.match(/\/detail\//g) || []).length, 1);
  fixture.view.setViewMode('grid');
  assert.doesNotMatch(fixture.nodes.get('#group').innerHTML, /\/detail\//);
});

test("group comparison renders one column per photo with unmatched placeholders and toggles off", () => {
  const fixture = reviewFixture([{ unitId: "unit:a", faces: [face(0.1)] }, { unitId: "unit:b" }]);
  fixture.view.render();
  assert.equal(fixture.nodes.get("#compareFaces").hidden, false);
  fixture.view.toggleFaces();
  const html = fixture.nodes.get("#group").innerHTML;
  assert.equal((html.match(/class="face-column"/g) || []).length, 2);
  assert.match(html, /未匹配/);
  assert.equal(fixture.state().faceCompare, true);
  fixture.view.toggleFaces();
  assert.equal(fixture.state().faceCompare, false);
});

test("F shortcut respects input and browser modifiers; comparison resets at group boundaries", () => {
  assert.deepEqual(keyboardAction({ key: "F" }), { type: "faceCompare" });
  assert.equal(keyboardAction({ key: "f" }, true), null);
  assert.equal(keyboardAction({ key: "f", metaKey: true }), null);
  assert.equal(keyboardAction({ key: "f", ctrlKey: true }), null);
  const state = { ...initialState, faceCompare: true };
  assert.equal(reduceState(state, { type: "faceCompare", value: false }).faceCompare, false);
  assert.equal(reduceState(state, { type: "group", index: 0 }).faceCompare, false);
  assert.equal(reduceState(state, { type: "filter", value: "all" }).faceCompare, false);
});


test("native magnifier compares matching faces and uses conflict-free shortcuts", () => {
  const fixture = reviewFixture([{ unitId: "unit:a", faces: [face(0.1), face(0.7)] }, { unitId: "unit:b", faces: [face(0.71)] }]);
  fixture.view.render();
  fixture.view.nativeAction("nativeMagnifier");
  assert.match(fixture.nodes.get("#group").innerHTML, /focus-crop\/unit%3Aa\/0/);
  assert.match(fixture.nodes.get("#group").innerHTML, /未匹配人脸/);
  fixture.view.nativeAction("nativeNextFace");
  assert.match(fixture.nodes.get("#group").innerHTML, /focus-crop\/unit%3Aa\/1/);
  fixture.view.nativeAction("nativeRegion");
  assert.match(fixture.nodes.get("#group").innerHTML, /region=eyes/);
  assert.deepEqual(keyboardAction({ key: "l" }), { type: "nativeMagnifier" });
  assert.deepEqual(keyboardAction({ key: "L", shiftKey: true }), { type: "nativeNextFace" });
  assert.deepEqual(keyboardAction({ key: "e" }), { type: "nativeRegion" });
  assert.equal(keyboardAction({ key: "l" }, true), null);
  assert.equal(keyboardAction({ key: "e", ctrlKey: true }), null);
});
