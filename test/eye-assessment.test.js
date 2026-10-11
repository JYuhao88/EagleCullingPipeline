import test from 'node:test';
import assert from 'node:assert/strict';
import { assessClosedEyes, measureEyeGeometry } from '../src/core/eye-assessment.js';
import { rankGroup, gateFlags, suggestDecision } from '../src/core/ranking.js';
import { evaluateRules } from '../src/core/rules-engine.js';

function unit({ear=.08, pitch=.33, yaw=0, closed=true, eyeScale=1, confidence=.95}={}) {
  const points=Array.from({length:133},()=>[.5,.3,.95]);
  const eyeY=.25, span=.06*eyeScale;
  for (const [start,cx] of [[36,.44],[42,.56]]) {
    const e=[[cx-span/2,eyeY],[cx-span/4,eyeY-ear*span/2],[cx+span/4,eyeY-ear*span/2],
      [cx+span/2,eyeY],[cx+span/4,eyeY+ear*span/2],[cx-span/4,eyeY+ear*span/2]];
    e.forEach((p,i)=>points[23+start+i]=[...p,confidence]);
  }
  points[23+8]=[.5,.45,.95];
  points[23+30]=[.5+yaw*.18,eyeY+pitch*.2,.95];
  return {metrics:{faces:1,eyesClosed:closed?1:0},faces:[{box:[.35,.17,.65,.47],eyesAssessed:true,
    eyesClosed:closed,blinkLeft:closed?.9:.05,blinkRight:closed?.9:.05}],
    signals:{source:{proxyWidth:1000,proxyHeight:1000},persons:[{isMain:true,box:[.2,.1,.8,.95],score:.95,
      keypoints:{format:'coco-wholebody-133',points}}]}};
}
test('frontal closed lids provide bilateral EAR and a reliable blink gate',()=> {
  const u=unit(); const g=measureEyeGeometry(u.signals.persons[0],u.signals.source);
  assert.ok(Math.abs(g.leftEar-.08)<1e-10);
  assert.equal(assessClosedEyes(u).gate,true);
});
test('downward gaze is a warning; extreme closure requires same-group open evidence',()=> {
  const downward=unit({ear:.2,pitch:.65});
  assert.equal(assessClosedEyes(downward).gate,false);
  assert.equal(assessClosedEyes(downward).warn,true);
  const extreme=unit({ear:.05,pitch:.65});
  assert.equal(assessClosedEyes(extreme).gate,false);
  const open=unit({ear:.35,closed:false});
  assert.equal(assessClosedEyes(extreme,[extreme,open]).gate,true);
  assert.equal(assessClosedEyes(downward,[downward,open]).gate,false);
});
test('side turns, tiny eye regions and weak keypoints only warn',()=> {
  for(const u of [unit({yaw:.7}),unit({eyeScale:.05}),unit({confidence:.4})]) {
    assert.equal(assessClosedEyes(u).gate,false);
    assert.equal(assessClosedEyes(u).warn,true);
  }
});
test('low supplied face confidence overrides otherwise reliable blink',()=> {
  const u=unit();u.faces[0].confidence=.4;
  assert.equal(assessClosedEyes(u).gate,false);
  assert.equal(assessClosedEyes(u).warn,true);
});
test('open frame suppresses ordinary closure gate while obvious blink remains gated',()=> {
  const closed=unit({ear:.2});closed.faces[0].blinkLeft=.65;closed.faces[0].blinkRight=.65;
  const open=unit({ear:.35,closed:false});
  assert.equal(assessClosedEyes(closed).gate,true);
  assert.equal(assessClosedEyes(closed,[closed,open]).gate,false);
  assert.equal(assessClosedEyes(unit(),[open]).gate,true);
  open.faces[0].box=[.01,.01,.1,.1];
  assert.equal(assessClosedEyes(closed,[closed,open]).gate,true);
});
test('background closed face cannot gate main subject even inside overlapping body box',()=> {
  const u=unit({closed:false});u.metrics.eyesClosed=1;
  u.faces.push({box:[.65,.5,.75,.6],eyesAssessed:true,eyesClosed:true,blinkLeft:.9,blinkRight:.9});
  const a=assessClosedEyes(u);
  assert.equal(a.closed,false);assert.equal(a.gate,false);
});
test('rules report downward closure as warn and frontal blink as violate',()=> {
  for (const [u,expected] of [[unit({pitch:.65,ear:.2}),'warn'],[unit(),'violate']])
    assert.equal(evaluateRules(u.signals,{faces:u.faces}).find(v=>v.ruleId==='P-FACE-EYES').verdict,expected);
});
test('legacy counters retained; current faces missing reliable pose abstain',()=> {
  assert.equal(assessClosedEyes({metrics:{eyesClosed:1}}).gate,true);
  const u=unit();delete u.signals.persons[0].keypoints;
  assert.equal(assessClosedEyes(u).gate,false);
});

test('ordinary closure with an open peer ranks after it without rejection or result mutation',()=> {
  const closed=unit({ear:.2}), open=unit({ear:.35,closed:false});
  closed.faces[0].blinkLeft=.65;closed.faces[0].blinkRight=.65;
  closed.unitId='closed';open.unitId='open';
  closed.metrics.quality=.99;open.metrics.quality=.5;
  const snapshot=JSON.stringify(closed.metrics);
  const ranked=rankGroup([closed,open],{quality:1});
  assert.equal(ranked[0].unitId,'open');
  assert.equal(gateFlags(closed).includes('eyes-closed'),false);
  assert.equal(suggestDecision(ranked[1],closed,2),'candidate');
  assert.equal(JSON.stringify(closed.metrics),snapshot);
  assert.equal(Object.hasOwn(closed,'eyeAssessment'),false);
  rankGroup([closed]);
  assert.equal(gateFlags(closed).includes('eyes-closed'),true);
});
