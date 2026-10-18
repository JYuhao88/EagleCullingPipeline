import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binary, parseAnswer } from '../scripts/observe-teacher.mjs';

test('answers parse from fenced or plain JSON and map labels back to option ids', () => {
  assert.deepEqual(parseAnswer('```json\n{"smile":"微笑","mouth":"闭合","eyes":"不存在"}\n```'), { smile: 'slight', mouth: 'closed' });
  assert.deepEqual(parseAnswer('答案：{"gaze":"看别处"}'), { gaze: 'away' });
  assert.equal(parseAnswer('no json here'), null);
});

test('看不清 abstains instead of counting as no', () => {
  assert.equal(binary('smile', 'unsure'), null);
  assert.equal(binary('smile', 'big'), 1);
  assert.equal(binary('smile', 'none'), 0);
  assert.equal(binary('mouth', 'slight'), 1);
});
