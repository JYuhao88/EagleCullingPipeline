import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUnitResult, validateSignals, validateRuleVerdict, contractError } from '../src/core/contracts.js';
import { computeSignals } from '../src/core/signals.js';

function pose() {
  const points = Array.from({ length: 133 }, () => [0.5, 0.5, 0]);
  const set = (i, x, y, score = 0.95) => { points[i] = [x, y, score]; };
  set(44, 0.49, 0.2); set(45, 0.51, 0.2); set(31, 0.5, 0.3);
  for (const [i, x, y] of [[5,.4,.38],[6,.6,.38],[7,.35,.5],[8,.65,.5],[9,.32,.6],[10,.68,.6],[11,.43,.6],[12,.57,.6],[13,.43,
    .77],[14,.57,.77],[15,.43,.9],[16,.57,.9]]) set(i,x,y);
  for (let i = 17; i <= 22; i++) set(i, i < 20 ? .43 : .57, .95);
  return { width: 1000, height: 1000, persons: [{ box: [.3,.1,.7,.97], score:.9, isMain:true,
    keypoints:{format:'coco-wholebody-133', points} }] };
}
const measured = (v) => computeSignals(v).persons[0];

test('face-based head height and hairline headroom, preserved person contract', () => {
  const input = pose();
  const result = computeSignals(input, { source: { width: 6000, height: 6000, kind: 'jpeg' } });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.source.proxyWidth, 1000);
  assert.equal(result.source.width, 6000);
  assert.equal(result.persons[0].headHeight, .165);
  assert.equal(result.persons[0].headroomHeads, .8182);
  assert.equal(result.persons[0].keypoints.format, 'coco-wholebody-133');
  assert.equal(result.persons[0].framingTier, 'full');
  assert.deepEqual(result.persons[0].handsTruncated, []);
});

test('headroom and top hairline cut can be negative', () => {
  const input = pose(), p = input.persons[0].keypoints.points;
  p[44][1] = p[45][1] = .06; p[31][1] = .16;
  const result = measured(input);
  assert.equal(result.headroomHeads, -.0303);
  assert.ok(result.edgeAtJoint.some(w => w.joint === 'hairline' && w.edge === 'top'));
});

test('all edge joints, sides and narrow edge distances', () => {
  for (const [index, joint, edge, x, y] of [
    [7,'elbow','left',.01,.5], [9,'wrist','right',.99,.6],
    [13,'knee','bottom',.43,.99], [15,'ankle','bottom',.43,.99],
    [17,'foot','bottom',.43,.99],
  ]) {
    const input = pose(); input.persons[0].keypoints.points[index] = [x,y,.9];
    const warning = measured(input).edgeAtJoint.find(w => w.joint === joint && w.edge === edge);
    assert.ok(warning, joint);
    assert.equal(warning.side, 'left');
    assert.equal(warning.distanceHeads, .0606);
  }
  const input = pose(), p = input.persons[0].keypoints.points;
  p[94] = [.98,.6,.9]; p[95] = [1,.6,.9];
  const result = measured(input);
  assert.ok(result.edgeAtJoint.some(w => w.joint === 'fingers' && w.edge === 'right'));
  assert.deepEqual(result.handsTruncated, [{side:'left',edge:'right'}]);
});

test('neck near bottom needs visible adjacent chin', () => {
  const input = pose(), p = input.persons[0].keypoints.points;
  p[44][1] = p[45][1] = .8; p[31][1] = .9;
  p[5][1] = p[6][1] = 1.08;
  assert.ok(measured(input).edgeAtJoint.some(w => w.joint === 'neck' && w.edge === 'bottom'));
});

test('joint exactly at edge and reliable outside predictions are cuts; distant weak predictions are unknown', () => {
  for (const y of [1, 1.01]) {
    const input = pose(); input.persons[0].keypoints.points[13][1] = y;
    const result = measured(input);
    const warning = result.edgeAtJoint.find(w => w.joint === 'knee');
    assert.ok(warning);
    assert.ok(warning.distanceHeads <= 0);
    assert.equal(result.framingTier, 'knee-cut');
  }
  const input = pose(); input.persons[0].keypoints.points[13][1] = 1.2;
  assert.ok(measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
  input.persons[0].keypoints.points[13][2] = .1;
  assert.ok(!measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
});

test('low score edge prediction needs visible neighbouring joint; interior occlusion never creates a cut', () => {
  const input = pose(), p = input.persons[0].keypoints.points;
  p[13] = [.43, 1, .1];
  assert.ok(measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
  p[11][2] = .1;
  assert.ok(!measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
  p[11][2] = .9; p[13][1] = .77;
  assert.ok(!measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
  p[13] = [.43, 1, 0];
  assert.ok(!measured(input).edgeAtJoint.some(w => w.joint === 'knee'));
});

test('edge distance uses image aspect ratio, not normalized x as head heights', () => {
  const input = pose(); input.width = 2000;
  input.persons[0].keypoints.points[9] = [.02,.6,.9];
  assert.ok(!measured(input).edgeAtJoint.some(w => w.joint === 'wrist'));
  input.width = 1000;
  assert.equal(measured(input).edgeAtJoint.find(w => w.joint === 'wrist').distanceHeads, .1212);
});

test('chest, waist and thigh tiers use actual shoulder/hip/knee intervals', () => {
  for (const [hips, knees, expected] of [[1.8,2.3,'chest'],[1.15,1.6,'waist'],[.8,1.3,'thigh']]) {
    const input = pose(), p = input.persons[0].keypoints.points;
    p[11][1] = p[12][1] = hips; p[13][1] = p[14][1] = knees;
    for (let i = 15; i <= 22; i++) p[i][2] = 0;
    assert.equal(measured(input).framingTier, expected);
  }
  const input = pose(); input.persons[0].keypoints.points[17][2] = 0;
  assert.equal(measured(input).framingTier, 'other');
});

test('clockwise positive pixel angles and relative shoulder/hip angle', () => {
  const input = pose(), p = input.persons[0].keypoints.points;
  p[6][1] = .48; p[12][1] = .53;
  assert.equal(measured(input).shoulderTilt, 26.5651);
  assert.equal(measured(input).hipTilt, -26.5651);
  assert.equal(measured(input).shoulderHipAngle, 53.1302);
  input.width = 2000;
  assert.equal(measured(input).shoulderTilt, 14.0362);
  [p[5],p[6]] = [p[6],p[5]];
  assert.equal(measured(input).shoulderTilt, 14.0362);
});

test('missing head/limb measurements are omitted; empty scenes retain valid contract', () => {
  const input = pose(), p = input.persons[0].keypoints.points;
  p[31][2] = .1; p[5][2] = .1;
  const result = measured(input);
  for (const key of ['headHeight','headroomHeads','edgeAtJoint','handsTruncated','framingTier','shoulderTilt','shoulderHipAngle'])
    assert.ok(!(key in result), key);
  assert.equal(result.hipTilt, 0);
  assert.deepEqual(computeSignals({width:1000,height:500,persons:[]}).persons, []);
});

test('worker source dimensions drive aspect and output coordinates clip without changing raw measurements', () => {
  const input = pose();
  input.source = { width:2000, height:1000, proxyWidth:2000, proxyHeight:1000, kind:'jpeg' };
  delete input.width; delete input.height;
  input.persons[0].keypoints.points[9] = [.02,.6,.9];
  input.persons[0].keypoints.points[13] = [.43,1.01,.9];
  const signals = computeSignals(input);
  assert.equal(signals.source.proxyWidth, 2000);
  assert.ok(!signals.persons[0].edgeAtJoint.some(w => w.joint === 'wrist'));
  assert.equal(signals.persons[0].keypoints.points[13][1], 1);
  assert.equal(input.persons[0].keypoints.points[13][1], 1.01);
  assert.ok(signals.persons[0].edgeAtJoint.find(w => w.joint === 'knee').distanceHeads < 0);
});

test('optional UnitResult additions preserve old results and validate populated signals/verdicts', () => {
  const legacy = {contractVersion:1,unitId:'unit:one',fingerprint:'fingerprint'};
  const verdict = {contractVersion:1,ruleId:'P-CROP-KNEE',rulesVersion:'portrait@0.1.0',verdict:'pass',by:'measure',
    evidence:'膝盖未贴边',personIndex:0};
  assert.equal(validateUnitResult(legacy), true);
  assert.equal(validateSignals(computeSignals(pose())), true);
  assert.equal(validateRuleVerdict(verdict), true);
  assert.equal(validateUnitResult({...legacy,signals:computeSignals(pose()),verdicts:[verdict]}), true);
  assert.equal(contractError('Signals', computeSignals(pose())).contractVersion, 1);
  assert.equal(validateUnitResult({...legacy,signals:null}), false);
  assert.equal(validateUnitResult({...legacy,verdicts:null}), false);
  assert.equal(validateRuleVerdict({...verdict,verdict:'good'}), false);
  assert.equal(validateRuleVerdict({...verdict,personIndex:-1}), false);
});

test('signal validator rejects malformed optional measurements, points and source', () => {
  for (const [key, value] of [['headHeight',null],['headroomHeads',Infinity],['framingTier','ankle-cut'],['handsTruncated',
    [{side:'both',edge:'bottom'}]],['edgeAtJoint',[{edge:'diagonal',joint:'knee',distanceHeads:0}]]]) {
    const signals = computeSignals(pose()); signals.persons[0][key] = value;
    assert.equal(validateSignals(signals), false, key);
  }
  const signals = computeSignals(pose());
  signals.persons[0].keypoints.points[0][0] = 1.2;
  assert.equal(validateSignals(signals), false);
  assert.equal(validateSignals({...computeSignals(pose()),source:{proxyWidth:1000,proxyHeight:1000}}), false);
});

 test('strict 0.15 head-height boundary is excluded', () => {
   const input=pose(), p=input.persons[0].keypoints.points;
   p[13][1]=1-.165*.15;
   assert.ok(!measured(input).edgeAtJoint.some(w=>w.joint==='knee'));
   p[13][1]+=0.000001;
   assert.ok(measured(input).edgeAtJoint.some(w=>w.joint==='knee'));
 });

test('compressed lower limb at frame border is unobservable, even with high model scores', () => {
  const input=pose(), p=input.persons[0].keypoints.points;
  for (const [k,a,foot] of [[13,15,17],[14,16,20]]) {
    p[k][1]=.96; p[a][1]=.99;
    for(let i=foot;i<foot+3;i++)p[i][1]=.995;
  }
  const result=measured(input);
  assert.ok(!result.edgeAtJoint.some(w=>['knee','ankle','foot'].includes(w.joint)));
  assert.equal(result.framingTier,undefined);
  assert.equal(result.keypoints.points[15][2],.95);
});
