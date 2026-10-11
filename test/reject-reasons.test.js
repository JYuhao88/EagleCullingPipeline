import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const ruleRoot = new URL('../src/rules/', import.meta.url);
const vocabulary = JSON.parse(await readFile(new URL('reject-reasons.json', ruleRoot), 'utf8'));

async function existingRuleIds() {
  const ids = new Set();
  for (const directory of [ruleRoot, new URL('candidates/', ruleRoot)]) {
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.json'))) {
      const library = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
      for (const rule of library.rules || []) ids.add(rule.id);
    }
  }
  return ids;
}

test('reject vocabulary has concise unique reasons and references existing rules only', async () => {
  const ruleIds = await existingRuleIds();
  assert.equal(vocabulary.contractVersion, 1);
  assert.ok(vocabulary.reasons.length >= 12 && vocabulary.reasons.length <= 16);
  const ids = new Set();
  const labels = new Set();
  const hotkeys = new Set();
  for (const reason of vocabulary.reasons) {
    assert.match(reason.id, /^R-[A-Z]+(?:-[A-Z]+)+$/);
    assert.ok(!ids.has(reason.id), `duplicate ${reason.id}`);
    ids.add(reason.id);
    assert.ok(reason.label && [...reason.label].length <= 6, reason.id);
    assert.ok(!labels.has(reason.label), `duplicate label ${reason.label}`);
    labels.add(reason.label);
    assert.ok(['general', 'portrait', 'landscape', 'street'].includes(reason.genre), reason.id);
    assert.ok(Array.isArray(reason.ruleIds), reason.id);
    assert.equal(new Set(reason.ruleIds).size, reason.ruleIds.length, reason.id);
    for (const id of reason.ruleIds) assert.ok(ruleIds.has(id), `${reason.id}: unknown rule ${id}`);
    if (reason.hotkey !== undefined) {
      assert.match(reason.hotkey, /^[1-9]$/);
      assert.ok(!hotkeys.has(reason.hotkey), `duplicate hotkey ${reason.hotkey}`);
      hotkeys.add(reason.hotkey);
    }
  }
  assert.equal(hotkeys.size, 9);
  assert.deepEqual(vocabulary.rules, [], 'reason metadata must not become executable rules');
});

test('reject vocabulary covers every Xiaohongshu reason and required technical categories', async () => {
  const source = JSON.parse(await readFile(new URL('candidates/reject-reasons.json', ruleRoot), 'utf8'));
  const mappedRules = new Set(vocabulary.reasons.flatMap((reason) => reason.ruleIds));
  for (const reason of source.reasons) {
    assert.ok(reason.ruleIds.every((id) => mappedRules.has(id)), `missing source category ${reason.label}`);
  }
  const labels = new Set(vocabulary.reasons.map((reason) => reason.label));
  for (const label of ['模糊失焦', '闭眼', '表情不好', '切到关节', '构图歪', '曝光过度', '曝光不足',
    '主体不突出', '背景杂乱', '偏色', '重复多余', '其他']) assert.ok(labels.has(label), label);
  assert.deepEqual(vocabulary.reasons.find((reason) => reason.label === '重复多余').ruleIds, [],
    'redundant burst frames are a user preference, not a sequence-preservation violation');
});
