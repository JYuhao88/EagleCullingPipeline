import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReview, renderGuide } from '../scripts/consolidate-rules-review.mjs';
const review = JSON.parse(await readFile(new URL('../src/rules/candidates/consolidated-review.json', import.meta.url)));

test('consolidated review is reproducible from existing inputs and covers each candidate and formal rule once', async () => {
  assert.deepEqual(await buildReview(), review);
  assert.equal((await readFile(new URL('../docs/rules-review-guide.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'), renderGuide(review));
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

test('evidence counts distinguish cited rows, support locators, and original frequency reports', () => {
 for(const entry of [...review.entries,...review.formalRules]){
  const s=entry.evidenceSummary;
  assert.equal(Object.values(s.totals).reduce((a,b)=>a+b,0),s.evidence.length);
  assert.equal(s.sourceTypeCount,new Set(s.evidence.map(e=>e.type)).size);
  for(const kind of ['source','exception','counterpoint']){
   assert.equal(s.totals[kind],s.evidence.filter(e=>e.kind===kind).length);
   assert.equal(s.totals[kind],Object.values(s.bySource).reduce((n,e)=>n+e[`${kind}Count`],0));
  }
  assert.ok(s.evidence.every(e=>Array.from(e.paraphrase).length<=40));
  const keys=s.evidence.map(e=>JSON.stringify([e.type,e.source,e.kind,e.locator,e.citationHash]));
  assert.equal(new Set(keys).size,keys.length);
 }
 const e=review.entries.find(e=>e.id==='P-YD-TONAL-GRAY');
 assert.ok(e.evidenceSummary.yidao.reportedSegmentsLowerBound>e.evidenceSummary.yidao.observedSegments);
 assert.equal(e.evidenceSummary.yidao.reportedSegmentsLowerBound,106);
 assert.ok(e.evidenceSummary.frequencyReports.some(r=>r.tierContrast?.unknown===83));
 assert.ok(review.entries.some(e=>e.evidenceSummary.evidence.some(r=>r.supportCount>1)));
});

test('priorities are deterministic and exceptions keep formal rule provenance separate from counterpoints', () => {
 review.entries.forEach((e,i)=>{
  assert.equal(e.priority.rank,i+1);
  assert.equal(e.priority.score,Object.values(e.priority.components).reduce((a,b)=>a+b,0));
  if(i)assert.ok(review.entries[i-1].priority.score>=e.priority.score);
 });
 assert.equal(review.exceptionGroups.length,review.counts.exceptionGroups);
 assert.equal(review.exceptionGroups.reduce((n,g)=>n+g.count,0),review.counts.exceptions);
 for(const group of review.exceptionGroups){
  assert.ok(review.formalRules.some(r=>r.id===group.ruleId));
  assert.equal(group.count,group.items.length);
  assert.ok(group.representatives.length>=1 && group.representatives.length<=3);
  assert.ok(group.items.every(e=>e.kind==='exception' && e.ruleId===group.ruleId));
  assert.ok(group.representatives.every(e=>group.items.some(i=>JSON.stringify(e)===JSON.stringify(i))));
 }
});
