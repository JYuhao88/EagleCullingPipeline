import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, isDarkTheme, applyTheme, initEagleTheme } from '../src/plugin/theme.js';

function fakeDocument() {
  const attributes = {};
  return { documentElement: { dataset: {}, style: {} }, body: { setAttribute: (key, value) => { attributes[key] = value; } }, attributes };
}

test('theme names normalize to Eagle themes with a dark or light fallback', () => {
  assert.equal(normalizeTheme('dark'), 'DARK');
  assert.equal(normalizeTheme('Auto', false), 'LIGHT');
  assert.equal(normalizeTheme(undefined, true), 'DARK');
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