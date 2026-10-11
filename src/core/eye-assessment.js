// COCO WholeBody contains the standard 68-point face at indices 23..90.
// These are conservative image-plane pose proxies, not calibrated 3-D angles.
import { createRequire } from 'node:module';
export const EYE_THRESHOLDS = Object.freeze(createRequire(import.meta.url)('./ranking-weights.json').eyes);
const finite = Number.isFinite;
const area = b => (b[2]-b[0])*(b[3]-b[1]);
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(finite) && area(b)>0 && b[2]>b[0] && b[3]>b[1];
const center = b => [(b[0]+b[2])/2,(b[1]+b[3])/2];
const inside = (p,b) => p[0]>=b[0] && p[0]<=b[2] && p[1]>=b[1] && p[1]<=b[3];

export function measureEyeGeometry(person, source = {}) {
  const points = person?.keypoints?.points;
  if (!points || points.length < 91) return undefined;
  const width = source.proxyWidth || source.width, height = source.proxyHeight || source.height;
  const aspect = finite(width) && finite(height) && height>0 ? width/height : 1;
  const p = i => points[23+i];
  const required = [8,30,36,37,38,39,40,41,42,43,44,45,46,47].map(p);
  if (required.some(x => !Array.isArray(x) || !x.slice(0,3).every(finite))) return undefined;
  const distance = (a,b) => Math.hypot((a[0]-b[0])*aspect,a[1]-b[1]);
  const eye = start => {
    const e = Array.from({length:6},(_,i)=>p(start+i));
    const span = distance(e[0],e[3]);
    return { ear: span>0 ? (distance(e[1],e[5])+distance(e[2],e[4]))/(2*span) : null, span };
  };
  const left = eye(36), right = eye(42);
  if (!(left.span>0 && right.span>0)) return undefined;
  const eyes = [p(36),p(39),p(42),p(45)];
  const ex = eyes.reduce((s,x)=>s+x[0],0)/4, ey = eyes.reduce((s,x)=>s+x[1],0)/4;
  const chinSpan = p(8)[1]-ey;
  const interocular = distance(p(36),p(45));
  return { leftEar: left.ear, rightEar: right.ear,
    pitchRatio: chinSpan>0 ? (p(30)[1]-ey)/chinSpan : null,
    yawRatio: interocular>0 ? Math.abs((p(30)[0]-ex)*aspect/interocular) : null,
    minEyePixels: finite(height) ? Math.min(left.span,right.span)*height : null,
    confidence: Math.min(...required.map(x=>x[2])), eyeCenter: [ex,ey] };
}

function candidates(unit) {
  const faces = (unit.faces || []).filter(f=>validBox(f?.box));
  const persons = (unit.signals?.persons || []).filter(p=>p.isMain && validBox(p.box));
  if (!persons.length) return faces.map(face=>({face}));
  return persons.map(person=> {
    const geometry = measureEyeGeometry(person,unit.signals?.source);
    // A body rectangle can overlap several people. Eye location must also be
    // inside the detected face when RTMW supplies a nondegenerate prediction.
    const face = faces.filter(f=>inside(center(f.box),person.box) &&
      (!geometry || inside(geometry.eyeCenter,f.box))).sort((a,b)=>area(b.box)-area(a.box))[0];
    return {face,person,geometry};
  }).filter(x=>x.face);
}
function sameFace(a,b) {
  if (a.identityId !== undefined || b.identityId !== undefined)
    return a.identityId !== undefined && a.identityId === b.identityId;
  // Spatial continuity is only a within-group identity proxy. Abstain when
  // multiple faces could match; do not match by largest-face index.
  const ac=center(a.box),bc=center(b.box), scale=Math.sqrt(area(a.box));
  return Math.hypot(ac[0]-bc[0],ac[1]-bc[1]) < .6*scale &&
    area(b.box)/area(a.box)>.5 && area(b.box)/area(a.box)<2;
}

export function assessClosedEyes(unit, groupUnits = []) {
  const t=EYE_THRESHOLDS;
  const rawClosed = unit.metrics?.eyesClosed>0 || (unit.flags || unit.qualityFlags || []).includes('eyes-closed');
  const all = candidates(unit);
  // Older scalar-only Results have no evidence with which to revise the flag.
  if (!Array.isArray(unit.faces)) return {closed:rawClosed,gate:rawClosed,warn:false,assessed:false,
    evidence:'旧版闭眼计数；缺少面部明细'};
  const results = all.filter(x=>x.face.eyesAssessed && typeof x.face.eyesClosed==='boolean').map(({face,person,geometry:g})=> {
    const closed=face.eyesClosed;
    if (!closed) return {closed:false,gate:false,warn:false,assessed:true,evidence:'主体人物未检测到闭眼'};
    const bl=face.blinkLeft ?? face.eyeBlinkLeft, br=face.blinkRight ?? face.eyeBlinkRight;
    const obvious=finite(bl)&&finite(br)&&Math.min(bl,br)>=t.obviousBlinkMin && Math.max(bl,br)>=t.obviousBlinkMax;
    const hasCurrentEvidence=finite(bl)||finite(br)||Boolean(unit.signals?.source);
    const faceConfidence = face.confidence ?? face.score;
    const uncertain = g ? g.confidence<t.confidence || (finite(faceConfidence)&&faceConfidence<t.confidence) ||
      (finite(person?.score)&&person.score<t.confidence) ||
      !finite(g.pitchRatio) || !finite(g.yawRatio) || (finite(g.minEyePixels)&&g.minEyePixels<t.minEyePixels) : hasCurrentEvidence;
    const tilted=g && (g.pitchRatio>t.downwardRatio || g.pitchRatio<t.upwardRatio || g.yawRatio>t.yawRatio);
    const ear=g ? Math.max(g.leftEar,g.rightEar) : null;
    const openElsewhere=groupUnits.some(other=>other!==unit && candidates(other).filter(x=>sameFace(face,x.face)).length===1 &&
      candidates(other).some(x=>sameFace(face,x.face) && x.face.eyesAssessed && !x.face.eyesClosed &&
        (!x.geometry || (x.geometry.confidence>=t.confidence && Math.min(x.geometry.leftEar,x.geometry.rightEar)>.2))));
    let gate;
    if (tilted) gate=!uncertain && ear<=t.extremeEar && openElsewhere;
    else gate=!uncertain && (obvious || ((!g || ear<=t.closedEar) && !openElsewhere));
    // Real detections without RTMW cannot establish pose reliability.
    if (!g && hasCurrentEvidence) gate=false;
    const geometryEvidence = g ? `；EAR=${g.leftEar.toFixed(3)}/${g.rightEar.toFixed(3)}` +
      `，俯仰比例=${g.pitchRatio?.toFixed(3)}，侧转比例=${g.yawRatio?.toFixed(3)}` : '';
    const evidence = `主体闭眼信号${geometryEvidence}` +
      (uncertain ? '；眼部过小、低置信度或姿态不可可靠测量' : tilted ? '；明显俯仰/侧转，垂眼仅提示' : '') +
      (openElsewhere ? '；同组位置/尺度匹配人物有睁眼帧' : '') + (!gate ? '；降为提示' : '；可靠闭眼门槛');
    return {closed,gate,warn:!gate,assessed:true,obvious,openElsewhere,geometry:g,evidence};
  });
  if (!results.length) return {closed:false,gate:false,warn:rawClosed,assessed:false,
    evidence:rawClosed?'闭眼信号未匹配可靠主体脸；仅提示':'主体眼睛状态不可可靠测量'};
  const gate=results.some(x=>x.gate), closed=results.some(x=>x.closed);
  return {closed,gate,warn:results.some(x=>x.warn),assessed:true,subjects:results,
    evidence:results.map(x=>x.evidence).join('；')};
}
