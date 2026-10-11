import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { keyboardAction } from '../src/plugin/keyboard.js';
import { createFeedbackRecorder, defaultRejectReasons, renderRuleReasons, winnerChanges } from '../src/plugin/feedback.js';
import { effectiveFeedback } from '../src/server/feedback-store.js';
const reasons = JSON.parse(await readFile(new URL('../src/rules/reject-reasons.json', import.meta.url))).reasons;

test('reason keys temporarily shadow decision digits without changing navigation or input shortcuts', () => {
  for (let digit = 1; digit <= 9; digit++) {
    assert.deepEqual(keyboardAction({ key: String(digit) }, false, true), { type: 'rejectReason', index: digit - 1 });
    assert.equal(keyboardAction({ key: String(digit) }, true, true), null);
    assert.equal(keyboardAction({ key: String(digit), ctrlKey: true }, false, true), null);
  }
  assert.deepEqual(keyboardAction({ key: '3' }), { type: 'decision', action: 'rejected' });
  assert.deepEqual(keyboardAction({ key: 'Enter' }, false, true), { type: 'closeReasons' });
  assert.deepEqual(keyboardAction({ key: 'ArrowRight' }, false, true), { type: 'unit', delta: 1 });
  assert.deepEqual(keyboardAction({ key: 'z', metaKey: true }, false, true), { type: 'undo' });
});

test('defaults map violated rules and gate flags, distinguish directional exposure, exclude ordinary warn', () => {
  const catalog = { reasons, rules: [{ id: 'P-CROP-KNEE', severity: 'penalty' }] };
  assert.deepEqual(defaultRejectReasons({ flags: ['eyes-closed'], verdicts: [
    { ruleId: 'P-CROP-KNEE', verdict: 'violate' }, { ruleId: 'P-FACE-EXPRESSION', verdict: 'warn' }
  ] }, catalog), ['R-P-EYES', 'R-P-JOINT']);
  assert.deepEqual(defaultRejectReasons({ verdicts: [{ ruleId: 'P-EXPOSURE-INTENT', verdict: 'violate',
    evidence: '高光过曝' }] }, catalog), ['R-L-HIGHLIGHT']);
});

test('rule reasons use Chinese library labels, escape evidence, and collapse hint', () => {
  const html = renderRuleReasons({ verdicts: [
    { ruleId: 'one', verdict: 'violate', evidence: '<script>' },
    { ruleId: 'two', verdict: 'warn', evidence: '提示' }, { ruleId: 'one', verdict: 'pass' }
  ] }, { rules: [{ id: 'one', title: '膝盖裁切', severity: 'gate' }, { id: 'two', title: '肩髋姿态', severity: 'hint' }] });
  assert.match(html, /膝盖裁切/); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<details.*肩髋姿态/); assert.doesNotMatch(html, /<details[^>]*open/);
});

test('winner preference uses previous human winner then tool winner and ignores multiple keeps', () => {
  const before = { data: { groups: [{ unitIds: ['a', 'b'], suggested: { a: 'selected' } }] }, decisions: [] };
  const decisions = [{ unitId: 'a', action: 'candidate', source: 'human' }, { unitId: 'b', action: 'selected', source: 'human' }];
  assert.deepEqual(winnerChanges(before, decisions), [{ unitId: 'b', action: 'winner-change', reasons: [],
    prevWinner: 'a', newWinner: 'b' }]);
  assert.deepEqual(winnerChanges({ ...before, decisions: [{ unitId: 'b', action: 'selected', source: 'human' }] }, decisions), []);
});

test('background feedback amendments and batch undo cancel all versions while failures remain optional', async () => {
  const events = [];
  let failures = 0;
  const recorder = createFeedbackRecorder({ api: async (_path, options) => {
    const body = JSON.parse(options.body);
    if (body.unitId === 'fail') throw new Error('disk full');
    const event = { ...body, id: String(events.length + 1) }; events.push(event); return { event };
  }, onError: () => failures++ });
  const handle = recorder.record('r', { unitId: 'a', action: 'reject', reasons: ['R-P-EYES'] });
  recorder.revise(handle, ['R-P-JOINT']); recorder.revise(handle, []); recorder.undo([handle]);
  recorder.record('r', { unitId: 'fail', action: 'keep', reasons: [] });
  recorder.record('r', { unitId: 'b', action: 'keep', reasons: [] });
  await recorder.flush();
  assert.deepEqual(effectiveFeedback(events).map(event => event.unitId), ['b']);
  assert.equal(failures, 1); assert.equal(events.filter(event => event.action === 'undo').length, 3);
});
