import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRulesRouter } from '../src/server/rules-routes.js';
const root = new URL('../', import.meta.url).pathname;
const read = async (file) => JSON.parse(await readFile(new URL(`../src/rules/candidates/${file}`, import.meta.url), 'utf8'));
const validate = (e) => {
  assert.ok([...e.paraphrase].length <= 40);
  assert.equal(e.paraphrase, e.text);
  assert.match(e.frame, /^frames\/BV[A-Za-z0-9]+\/\d{4}\.jpg$/);
  assert.equal(Number(path.basename(e.frame, '.jpg')), e.segment);
  assert.ok(Number.isFinite(e.t) && e.t >= 0);
};
test('wulin candidates preserve conservative support, bounded locations and exact reviewed assignments', async () => {
  const [c, e, index, codebook, ns] = await Promise.all(['landscape-street-v0.2-candidates.json',
    'wulin-evidence.json','landscape-street-synthesis-index.json','landscape-street-synthesis-codebook.json',
    'landscape-street-non-selection.json'].map(read));
  assert.equal(c.inputSegments, 2591);
  assert.equal(c.synthesis.episodes, 40);
  assert.equal(c.rules.filter(r => r.library === 'landscape').length, 10);
  assert.equal(c.rules.filter(r => r.library === 'street').length, 1);
  const labels = new Map(index.entries.map(e => [e.paraphrase,e.assignments]));
  assert.equal(labels.size,index.entries.length);
  const ids = new Set([...codebook.rules,...codebook.nonSelection,...codebook.observations].map(r => r.id));
  for (const item of index.entries) {
    assert.ok([...item.paraphrase].length <= 40);
    item.assignments.forEach(id => assert.ok(ids.has(id) || ['unresolved','vague'].includes(id),id));
  }
  assert.deepEqual(labels.get('天空占比过大'), undefined); // extraction already mapped; no duplicate support
  assert.deepEqual(labels.get('作品整体精彩'), ['vague']);
  assert.deepEqual(labels.get('长曝光时长不足'), ['NS:CAPTURE-PLAN']);
  for (const r of c.rules) {
    assert.match(r.id,/^[LS]-WL-[A-Z-]+$/);
    assert.equal(r.status,'proposed');assert.equal(r.severity,'hint');assert.equal(r.source,'wulin-critiques');
    assert.ok(r.supportEpisodes>=3 && r.supportEpisodes<=40);
    assert.equal(r.supportEpisodes,r.frequency.episodes);assert.equal(r.supportSegments,r.frequency.segments);
    assert.equal(r.check.by,'teacher');assert.ok(r.exceptions.length);
    assert.ok(r.evidence.length>0 && r.evidence.length<=4);
    r.evidence.forEach(ev=>{validate(ev);assert.ok(labels.get(ev.text).includes(r.id));});
  }
  assert.equal(e.rules.length,22);
  assert.equal(e.rules.reduce((n,r)=>n+r.evidence.length,0),625);
  e.rules.forEach(r=>{r.evidence.forEach(validate);assert.ok(r.representatives.length<=4);});
  assert.equal(Object.values(c.synthesis.counts).reduce((a,b)=>a+b,0),c.synthesis.commentaryItems);
  assert.equal(ns.nonSelectionCount,c.synthesis.counts.nonSelection);
  assert.equal(ns.nonSelection.reduce((n,r)=>n+r.commentaryItems,0),ns.nonSelectionCount);
  ns.nonSelection.forEach(r=>assert.ok(!('evidence' in r)));
  codebook.crossEvidence.forEach(c=>{assert.ok(c.references.length);
    c.references.forEach(r=>assert.ok(r.locator && [...r.paraphrase].length<=40));
    });
});
test('wulin generator deduplicates support, rejects unknown text and invalid timestamps, filters below 3 episodes',async(t)=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'wulin-synthesis-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const out=path.join(tmp,'out');await mkdir(out);
  for(const n of ['codebook','index'])await copyFile(path.join(root,
    `src/rules/candidates/landscape-street-synthesis-${n}.json`),path.join(out,
    `landscape-street-synthesis-${n}.json`));
  const fixture={bvid:'BVTEST1',segment:{index:1,start:0,end:30},
    frame:'frames/BVTEST1/0001.jpg',issues:[{ruleId:null,text:'画面缺少兴趣点',
    t:12}],praises:[]};
  const dir=path.join(tmp,'extracted','BVTEST1');await mkdir(dir,{recursive:true});
  const put=async(row)=>writeFile(path.join(dir,'1.json'),JSON.stringify(row));await put(fixture);
  const run=()=>execFileSync('python3',[path.join(root,'src/rules/candidates/synthesize-landscape-street.py'),
    '--data-root',tmp,'--output-dir',out],{encoding:'utf8',stdio:'pipe'});

  const stats=JSON.parse(run());assert.equal(stats.commentaryItems,
    1);assert.equal(JSON.parse(await readFile(path.join(out,'landscape-street-v0.2-candidates.json'),
    'utf8')).rules.length,0);
  fixture.issues.push({...fixture.issues[0]});await put(fixture);assert.equal(JSON.parse(run()).commentaryItems,1);
  fixture.issues=[{ruleId:null,text:'未审核的新转述',t:12}];await put(fixture);assert.throws(run,/unreviewed paraphrase/);
  fixture.issues=[{ruleId:null,text:'画面缺少兴趣点',t:31}];await put(fixture);assert.throws(run,/timestamp outside segment/);
});
test('real repository review data exposes all wulin candidates and mapped cross-library evidence',async()=>{
  const router=createRulesRouter({projectRoot:root});let status,body;
  await router({method:'GET',url:'/rules/data'},{writeHead(s){status=s;},end(s){body=JSON.parse(s);}});
  assert.equal(status,200);assert.equal(body.wulinCandidates.rules.length,
    11);assert.equal(body.wulinEvidence.mappedEvidenceAssignments,625);

  const ref=body.referenceRules.find(r=>r.id==='L-NATURAL-COLOR');assert.equal(ref.wulinEvidence.length,146);
  assert.ok(body.rules.some(r=>r.id==='S-WL-INTERACTION'));
});
