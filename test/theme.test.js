import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, isDarkTheme, applyTheme, initEagleTheme } from '../src/plugin/theme.js';

function fakeDocument() {
  const attributes = {};
  return { documentElement: { dataset: {}, style: {} }, body: { setAttribute: (key, value) => { attributes[key] = value; } }, attributes };
}

test('theme names normalize the way Eagle does: Auto is GRAY or LIGHT, anything unreadable is GRAY', () => {
  assert.equal(normalizeTheme('dark'), 'DARK');
  assert.equal(normalizeTheme('Auto', false), 'LIGHT');
  assert.equal(normalizeTheme('Auto', true), 'GRAY');
  assert.equal(normalizeTheme(undefined, true), 'GRAY');
  assert.equal(normalizeTheme('undefined', false), 'GRAY');
  assert.equal(isDarkTheme('LIGHTGRAY'), false);
  assert.equal(isDarkTheme('PURPLE'), true);
});

test('applyTheme sets data-theme, color-scheme and the body theme attribute', () => {
  const doc = fakeDocument();
  assert.equal(applyTheme('LIGHT', doc), 'LIGHT');
  assert.equal(doc.documentElement.dataset.theme, 'LIGHT');
  assert.equal(doc.documentElement.style.colorScheme, 'light');
  assert.equal(doc.attributes.theme, 'LIGHT');
});

test('initEagleTheme resolves Auto through isDarkColors and follows theme changes', async () => {
  const doc = fakeDocument();
  let listener;
  const eagle = { app: { theme: Promise.resolve('Auto'), isDarkColors: async () => false },
    onThemeChanged: callback => { listener = callback; } };
  assert.equal(await initEagleTheme({ eagle, doc }), 'LIGHT');
  listener('BLUE');
  assert.equal(doc.documentElement.dataset.theme, 'BLUE');
});
test('initEagleTheme falls back to the URL theme when Eagle reports its preference as "undefined"', async () => {
  const doc = fakeDocument();
  const eagle = { app: { theme: 'undefined', isDarkColors: async () => true } };
  assert.equal(await initEagleTheme({ eagle, doc, search: '?id=A&theme=gray' }), 'GRAY');
  assert.equal(await initEagleTheme({ eagle, doc, search: '' }), 'GRAY');
  assert.equal(await initEagleTheme({ eagle: { app: { theme: 'Auto', isDarkColors: async () => true } }, doc }), 'GRAY');
  assert.equal(await initEagleTheme({ eagle: { app: { theme: 'BLUE' } }, doc, search: '?theme=light' }), 'BLUE');
});
