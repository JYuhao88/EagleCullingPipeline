import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReview } from '../scripts/consolidate-rules-review.mjs';
const review = JSON.parse(await readFile(new URL('../src/rules/candidates/consolidated-review.json', import.meta.url)));

test('consolidated review is reproducible from existing inputs and covers each candidate and formal rule once', async () => {
  assert.deepEqual(await buildReview(), review);
  const ids=review.entries.flatMap(e=>[e.id,...e.aliases]);
  assert.equal(new Set(ids).size, review.counts.candidates);
  assert.equal(ids.length, review.counts.candidates);
  assert.equal(new Set(review.formalRules.map(e=>e.id)).size, review.counts.formalRules);
  assert.equal(review.isSuggestion,true);
  assert.ok(!review.inputFiles.includes('review/decisions.json'));
  for(const entry of review.entries){
    assert.equal(entry.isSuggestion,true);
    assert.ok(['approve','merge','reject','needs-measure'].includes(entry.recommendation));
    assert.deepEqual(entry.members.map(e=>e.id),[entry.id,...entry.aliases]);
    for(const alias of entry.aliases)assert.equal(review.aliasMap[alias],entry.id);
  }
});
