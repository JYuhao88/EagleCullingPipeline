import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewUx, REVIEW_WELCOME_KEY } from '../src/plugin/review-ux.js';
import { learningStatus } from '../src/plugin/learning-panel.js';

function setup(storage) {
  const nodes = new Map();
  const root = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      open: false, events: {},
      addEventListener(name, callback) { this.events[name] = callback; },
      showModal() { this.open = true; }, close() { this.open = false; }
    });
    return nodes.get(selector);
  } };
  const ux = createReviewUx({ root, storage });
  return { ux, node: id => root.querySelector(`#${id}`) };
}

test('first review guide dismisses persistently and can be reopened from help', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const { ux, node } = setup(storage);
  ux.enter(); assert.equal(node('reviewWelcome').open, true);
  node('closeReviewWelcome').events.click();
  assert.equal(values.get(REVIEW_WELCOME_KEY), 'dismissed');
  ux.enter(); assert.equal(node('reviewWelcome').open, false);
  node('reviewHelp').events.click(); assert.equal(node('shortcutHelp').open, true);
  node('helpReviewWelcome').events.click();
  assert.equal(node('shortcutHelp').open, false); assert.equal(node('reviewWelcome').open, true);
  const next = setup(storage); next.ux.enter(); assert.equal(next.node('reviewWelcome').open, false);
});

test('review guide remembers escape in-session even when storage is unavailable; settings open separately', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { ux, node } = setup(storage);
  ux.enter(); node('reviewWelcome').events.cancel(); node('reviewWelcome').close();
  ux.enter(); assert.equal(node('reviewWelcome').open, false);
  node('reviewMore').open = true; node('openReviewSettings').events.click();
  assert.equal(node('reviewMore').open, false); assert.equal(node('reviewSettings').open, true);
  node('closeReviewSettings').events.click(); assert.equal(node('reviewSettings').open, false);
});

test('learning status describes disabled defaults and validation without internal terms', () => {
  const status = learningStatus({ config: { enabled: false, pixelTier: 0 }, report: { ready: false } });
  assert.match(status, /个性化已关闭/); assert.match(status, /继续使用原排序/);
  assert.match(status, /额外保存细节图：关闭/); assert.doesNotMatch(status, /L0|L1|Profile|墓碑|档 0/);
});
