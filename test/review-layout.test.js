import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLayout, decisionBadge } from '../src/plugin/review-view.js';
import { keyboardAction } from '../src/plugin/keyboard.js';
test('compare layouts fill 2 and 4 columns, adapt to narrow windows, and paginate large groups', () => {
  assert.deepEqual(reviewLayout(2, 1400, 800), { start: 0, end: 2, columns: 2, rows: 1 });
  assert.deepEqual(reviewLayout(4, 1400, 800), { start: 0, end: 4, columns: 2, rows: 2 }, 'landscape photos use 2x2');
  assert.deepEqual(reviewLayout(4, 1400, 800, 'compare', 0, 2 / 3), { start: 0, end: 4, columns: 4, rows: 1 },
    'portrait photos stay side by side');
  assert.equal(reviewLayout(4, 600, 800).rows, 4);
  assert.equal(reviewLayout(2, 1400, 800, 'single', 39).start, 1, 'focus clamps after narrowing candidate mode');
  assert.deepEqual(reviewLayout(40, 1400, 800, 'compare', 19), { start: 16, end: 24, columns: 3, rows: 3 });
  assert.deepEqual(reviewLayout(40, 1400, 800, 'single', 19), { start: 19, end: 20, columns: 1, rows: 1 });
  const grid = reviewLayout(40, 600, 400, 'grid', 19);
  assert.equal(grid.end - grid.start, 6); assert.equal(grid.columns, 3);
});
test('badges distinguish weak AI suggestions from explicit decisions and keep candidate unmarked', () => {
  assert.match(decisionBadge({ source: 'suggested', action: 'selected' }), /suggested.*AI 建议/s);
  assert.match(decisionBadge({ source: 'human', action: 'selected' }), /human.*已决定/s);
  assert.match(decisionBadge({ source: 'human', action: 'rejected' }), /✕/);
  assert.equal(decisionBadge({ source: 'human', action: 'candidate' }), '');
  assert.equal(decisionBadge({ source: 'suggested', action: 'selected' }, true), '');
  assert.match(decisionBadge({ source: 'human', action: 'candidate', tie: true }), /≈/);
});
test('I C V B are new view shortcuts while all group correction and legacy keys retain their semantics', () => {
  assert.deepEqual(keyboardAction({ key: 'i' }), { type: 'info' });
  for (const [key, mode] of [['c', 'compare'], ['v', 'single'], ['b', 'grid']]) {
    assert.deepEqual(keyboardAction({ key }), { type: 'view', mode });
    assert.equal(keyboardAction({ key }, true), null);
    assert.equal(keyboardAction({ key, ctrlKey: true }), null);
  }
  assert.deepEqual(keyboardAction({ key: 'g', shiftKey: true }), { type: 'newGroup' });
  for (const [key, type] of [['1', 'decision'], ['2', 'decision'], ['3', 'decision'], ['s', 'selectBest'], ['u', 'undo'],
    ['z', 'syncZoom'], [' ', 'zoom'], ['a', 'selectAll'], ['Escape', 'clearSelection'], ['f', 'faceCompare'],
    ['l', 'nativeMagnifier'], ['e', 'nativeRegion'], ['m', 'moveUnit'], ['g', 'newGroup'], ['?', 'help']]) {
    assert.equal(keyboardAction({ key }).type, type);
  }
});
