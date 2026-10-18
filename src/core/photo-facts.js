// Plain facts about the main subject that a rule verdict or a measurement already backs, for located Eagle comments
// and for the inspector's photo-against-photo sentences. Nothing here changes scores or ranking.
const JOINT_POINTS = {
  wrist: { left: [9], right: [10] }, elbow: { left: [7], right: [8] }, knee: { left: [13], right: [14] },
  ankle: { left: [15], right: [16] }, foot: { left: [15, 17, 18, 19], right: [16, 20, 21, 22] },
  fingers: { left: range(91, 112), right: range(112, 133) },
};
const JOINT_NAMES = { wrist: '手腕', elbow: '手肘', knee: '膝盖', ankle: '脚踝', foot: '脚', fingers: '手指' };
const SIDE_NAMES = { left: '左', right: '右' };
const EDGE_NAMES = { top: '上', bottom: '下', left: '左', right: '右' };
// Each crop rule only speaks for its own joints; other joints near the edge belong to other rules.
const CROP_RULES = {
  'P-CROP-WRIST': { joints: ['wrist', 'fingers'], part: '手' }, 'P-CROP-ELBOW': { joints: ['elbow'], part: '手肘' },
  'P-CROP-KNEE': { joints: ['knee'], part: '膝盖' }, 'P-CROP-ANKLE-FOOT': { joints: ['ankle', 'foot'], part: '脚' },
};
const TILT_RULES = new Set(['L-HORIZON-LEVEL', 'L-VERTICAL-LEVEL']);

function range(from, to) { return Array.from({ length: to - from }, (_, i) => from + i); }
const clamp01 = value => Math.min(1, Math.max(0, value));
const finite = value => Number.isFinite(value) ? value : null;

function boxAround(points, pad) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [clamp01(Math.min(...xs) - pad), clamp01(Math.min(...ys) - pad),
    clamp01(Math.max(...xs) + pad), clamp01(Math.max(...ys) + pad)];
}

function overlap(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return w * h / Math.max(1e-9, (a[2] - a[0]) * (a[3] - a[1]));
}

// A negative distance means the joint is already past the frame edge.
export function cutText(cut) {
  const joint = `${SIDE_NAMES[cut.side] || ''}${JOINT_NAMES[cut.joint] || cut.joint}`, edge = EDGE_NAMES[cut.edge] || '';
  return cut.distanceHeads < 0 ? `${joint}被画面${edge}边切掉` : `画面${edge}边卡在${joint}附近`;
}

const mainPerson = result => (result.signals?.persons || []).find(person => person.isMain) || null;
const verdictsFor = (result, person) => (result.verdicts || []).filter(verdict =>
  verdict.personIndex === undefined || (result.signals?.persons || [])[verdict.personIndex] === person);

function mainFace(result, person) {
  if (!person) return null;
  const face = (result.faces || []).filter(f => Array.isArray(f.box))
    .sort((a, b) => overlap(b.box, person.box) - overlap(a.box, person.box))[0];
  return face && overlap(face.box, person.box) > 0.5 ? face : null;
}

function mainCuts(result, person) {
  const cuts = [];
  for (const verdict of verdictsFor(result, person)) {
    const rule = CROP_RULES[verdict.ruleId];
    if (!rule || verdict.verdict !== 'violate') continue;
    for (const cut of person.edgeAtJoint || []) if (rule.joints.includes(cut.joint)) cuts.push({ ...cut, part: rule.part });
  }
  return cuts;
}

// Only issues already confirmed by a rule verdict for the main subject and with a location on the image.
export function locatedIssues(result = {}) {
  const person = mainPerson(result);
  if (!person) return [];
  const issues = [];
  const verdicts = verdictsFor(result, person);
  const face = mainFace(result, person);
  if (verdicts.some(v => v.ruleId === 'P-FACE-EYES' && v.verdict === 'warn') && face?.eyesClosed && face.eyeBoxes?.length)
    issues.push({ kind: 'eyes', box: boxAround(face.eyeBoxes.flatMap(b => [[b[0], b[1]], [b[2], b[3]]]), 0.01), text: '闭眼' });
  for (const cut of mainCuts(result, person)) {
    const points = JOINT_POINTS[cut.joint]?.[cut.side]?.map(i => person.keypoints?.points?.[i]).filter(p => p && p[2] >= 0.3);
    if (!points?.length) continue;
    const box = boxAround(points.map(p => [clamp01(p[0]), clamp01(p[1])]), 0.04);
    if (!issues.some(issue => issue.kind === 'crop' && overlap(issue.box, box) > 0.5))
      issues.push({ kind: 'crop', box, text: cutText(cut) });
  }
  if (verdicts.some(v => v.ruleId === 'G-PROXY-BLUR' && v.verdict === 'warn')) issues.push({ kind: 'blur', box: person.box, text: '可能模糊' });
  return issues;
}

// Comparable facts for one photo; null means not measured, so no sentence can be built on it.
export function photoFacts(result = {}) {
  const person = mainPerson(result);
  const verdicts = verdictsFor(result, person);
  const eyes = verdicts.find(v => v.ruleId === 'P-FACE-EYES' && ['pass', 'warn', 'violate'].includes(v.verdict));
  const blur = (result.verdicts || []).find(v => v.ruleId === 'G-PROXY-BLUR' && ['pass', 'warn'].includes(v.verdict));
  const tilt = (result.verdicts || []).filter(v => TILT_RULES.has(v.ruleId));
  return {
    eyes: !person || !eyes ? null : eyes.verdict === 'pass' ? 'open' : 'closed',
    cuts: person ? [...new Set(mainCuts(result, person).map(cut => cut.part))] : null,
    blur: blur ? blur.verdict === 'warn' : null,
    eyeSharpness: finite(result.focus?.eyeSharpnessNative), faceSharpness: finite(result.focus?.faceSharpnessNative),
    subjectLuma: finite(result.metrics?.raw?.skyExposure?.subject?.meanLuma),
    faceClipped: finite(person?.faceClippedHighlights),
    tilted: tilt.some(v => v.verdict === 'violate') ? true
      : tilt.some(v => v.verdict === 'pass') && !tilt.some(v => v.verdict === 'warn') ? false : null,
  };
}
