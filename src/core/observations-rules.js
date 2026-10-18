import { photoFacts } from './photo-facts.js';
import { measurementPoints } from './signals.js';

const RULE_CONFIDENCE = 0.65;
const BACKGROUND_RATIO = 0.2;
const EDGE_RATIO = 0.1;
const SAME_SCALE_RATIO = 0.65;
const GROUP_MAIN_HEIGHT = 0.25;
const EDGE = 0.03;
const FOCUS_FACE_HEIGHT = 0.04;
const FOCUS_FACE_PIXELS = 64;
const FOCUS_CLIPPED = 0.5;

const finite = value => Number.isFinite(value);
const pointGood = point => Array.isArray(point) && point.length >= 3 && point.every(finite) && point[2] >= RULE_CONFIDENCE
  && point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1;
const validBox = box => Array.isArray(box) && box.length === 4 && box.every(finite) && box[2] > box[0] && box[3] > box[1]
  && box[0] >= 0 && box[1] >= 0 && box[2] <= 1 && box[3] <= 1;
const boxHeight = box => validBox(box) ? box[3] - box[1] : 0;
const boxArea = box => validBox(box) ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
const center = box => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

function overlap(a, b) {
  if (!validBox(a) || !validBox(b)) return 0;
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return width * height / Math.max(1e-9, boxArea(a));
}

function union(boxes) {
  const known = boxes.filter(validBox);
  if (!known.length) return undefined;
  return [Math.min(...known.map(box => box[0])), Math.min(...known.map(box => box[1])),
    Math.max(...known.map(box => box[2])), Math.max(...known.map(box => box[3]))];
}

function mainFace(result, person) {
  if (!person) return null;
  return (result.faces || []).filter(face => validBox(face.box))
    .sort((a, b) => overlap(b.box, person.box) - overlap(a.box, person.box))[0] || null;
}

function faceMatchesPoints(face, person) {
  const points = person?.keypoints?.points || [];
  const known = [points[0], points[1], points[2]].filter(pointGood);
  if (known.length < 3 || !validBox(face?.box)) return false;
  const pad = Math.max(0.02, boxHeight(face.box) * 0.35);
  return known.every(point => point[0] >= face.box[0] - pad && point[0] <= face.box[2] + pad
    && point[1] >= face.box[1] - pad && point[1] <= face.box[3] + pad);
}

function observation(id, text, tone, box) {
  return { id, text, tone, source: 'rule', ...(validBox(box) ? { box } : {}) };
}

function backgroundText(box) {
  const [x, y] = center(box);
  const horizontal = x < 1 / 3 ? '左' : x > 2 / 3 ? '右' : '';
  const vertical = y < 1 / 3 ? '上' : y > 2 / 3 ? '下' : '';
  if (horizontal && vertical) return `${horizontal}${vertical}有路人入镜`;
  if (horizontal) return `${horizontal}侧背景有人`;
  if (vertical) return `${vertical}方背景有人`;
  return '背景有人';
}

function backgroundObservations(persons, main) {
  if (!validBox(main?.box)) return [];
  const mainHeight = boxHeight(main.box);
  if (!(mainHeight > 0)) return [];
  const others = persons.map(person => ({ person, height: boxHeight(person.box) }))
    .filter(row => row.person !== main && validBox(row.person.box) && row.height > 0)
    .map(row => ({ ...row, ratio: row.height / mainHeight }));
  const sameScale = mainHeight >= GROUP_MAIN_HEIGHT ? others.filter(row => row.ratio >= SAME_SCALE_RATIO) : [];
  const out = [];
  if (sameScale.length) out.push(observation('multiple-people', '多人同框', 'neutral',
    union([main.box, ...sameScale.map(row => row.person.box)])));
  for (const row of others) {
    if (sameScale.includes(row)) continue;
    const box = row.person.box;
    const edgeCut = (box[0] <= EDGE || box[1] <= EDGE || box[2] >= 1 - EDGE || box[3] >= 1 - EDGE) && row.ratio >= EDGE_RATIO;
    if (row.ratio < BACKGROUND_RATIO && !edgeCut) continue;
    if (row.ratio < EDGE_RATIO) continue;
    out.push(observation('background-person', backgroundText(box), 'bad', box));
  }
  return out.sort((a, b) => (b.box ? boxArea(b.box) : 0) - (a.box ? boxArea(a.box) : 0));
}

function faceDirection(result, main) {
  const face = mainFace(result, main);
  const points = main?.keypoints?.points;
  if (!face || overlap(face.box, main.box) < 0.3 || boxHeight(face.box) < 0.04 || !Array.isArray(points)
    || !faceMatchesPoints(face, main)) return null;
  const measured = measurementPoints(main, sourceAspect(result));
  const nose = measured[0], eyes = [measured[1], measured[2]].filter(pointGood), ears = [measured[3], measured[4]]
    .filter(pointGood).sort((a, b) => a[0] - b[0]);
  if (!pointGood(nose) || eyes.length !== 2) return null;
  const sortedEyes = eyes.sort((a, b) => a[0] - b[0]);
  const eyeDistance = sortedEyes[1][0] - sortedEyes[0][0];
  if (!(eyeDistance >= 0.01)) return null;
  const eyeMid = [(sortedEyes[0][0] + sortedEyes[1][0]) / 2, (sortedEyes[0][1] + sortedEyes[1][1]) / 2];
  const yaw = (nose[0] - eyeMid[0]) / eyeDistance;
  if (Math.abs(yaw) >= 0.5 || (ears.length === 1 && Math.abs(yaw) >= 0.3))
    return observation('face-side', '侧脸', 'neutral', face.box);
  if (ears.length === 2 && Math.abs(yaw) <= 0.2) {
    const earSpan = ears[1][0] - ears[0][0];
    if (earSpan / eyeDistance >= 1.4 && earSpan / eyeDistance <= 3.5)
      return observation('face-front', '正脸', 'neutral', face.box);
  }
  return null;
}

function sourceAspect(result) {
  const source = result.source || result.signals?.source;
  return source?.width > 0 && source?.height > 0 ? source.width / source.height : 1;
}

function handBox(points) {
  const known = points.filter(pointGood);
  if (!known.length) return undefined;
  return [Math.max(0, Math.min(...known.map(point => point[0])) - 0.025),
    Math.max(0, Math.min(...known.map(point => point[1])) - 0.025),
    Math.min(1, Math.max(...known.map(point => point[0])) + 0.025),
    Math.min(1, Math.max(...known.map(point => point[1])) + 0.025)];
}

function gestureObservations(result, main, face) {
  if (!main?.keypoints?.points || !face || overlap(face.box, main.box) < 0.3 || !faceMatchesPoints(face, main)) return [];
  const points = measurementPoints(main, sourceAspect(result));
  const good = index => pointGood(points[index]);
  const out = [];
  const nearFace = [];
  for (const start of [91, 112]) for (let index = start; index < start + 21; index++) {
    if (!good(index)) continue;
    const point = points[index];
    const dx = Math.max(face.box[0] - point[0], 0, point[0] - face.box[2]);
    const dy = Math.max(face.box[1] - point[1], 0, point[1] - face.box[3]);
    if (Math.hypot(dx, dy) <= 0.03) nearFace.push(point);
  }
  if (nearFace.length >= 3) out.push(observation('hand-near-face', '手抬到脸附近', 'neutral', union([face.box, handBox(nearFace)])));
  return out;
}

const contains = (box, point) => point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];

function focusObservation(result, main) {
  const focus = result.focus;
  if (focus?.status !== 'ok' || focus.afSource !== 'FocusLocation' || !validBox(main.box)
    || result.signals.persons.filter(person => person.isMain).length !== 1 || !validBox(focus.afFrame)
    || !Array.isArray(focus.afPoint) || focus.afPoint.length !== 2
    || !focus.afPoint.every(value => finite(value) && value >= 0 && value <= 1)
    || !contains(focus.afFrame, focus.afPoint)) return null;
  // Focus flags aggregate all faces; recheck the location against the main subject only.
  const faces = (result.faces || []).filter(face => validBox(face.box) && overlap(face.box, main.box) > 0.5);
  if (faces.length !== 1 || boxHeight(faces[0].box) < FOCUS_FACE_HEIGHT || !faceMatchesPoints(faces[0], main)
    || !finite(main.faceExposurePixels) || main.faceExposurePixels < FOCUS_FACE_PIXELS
    || [main.faceClippedHighlights, main.faceClippedShadows]
      .some(value => !finite(value) || value < 0 || value >= FOCUS_CLIPPED)) return null;
  const face = faces[0], eyes = face.eyeBoxes;
  if (!Array.isArray(eyes) || eyes.length !== 2 || !eyes.every(box => validBox(box) && overlap(box, face.box) === 1)) return null;
  if (focus.afPointOnEye === true && focus.afPointOnSubject === true && eyes.some(box => contains(box, focus.afPoint)))
    return observation('focus-eye', '对焦点在眼部', 'neutral', focus.afFrame);
  return null;
}

export function ruleObservations(result = {}) {
  const persons = result.signals?.persons;
  const main = Array.isArray(persons) ? persons.find(person => person.isMain) : null;
  if (!main) return [];
  const face = mainFace(result, main);
  const out = [];
  if (photoFacts(result).eyes === 'closed') {
    const subjectFace = face && faceMatchesPoints(face, main) ? face : null;
    const eyeBoxes = subjectFace?.eyeBoxes?.filter(validBox) || [];
    out.push(observation('eyes-closed', '主体闭眼', 'bad', eyeBoxes.length ? union(eyeBoxes) : subjectFace?.box));
  }
  const focus = focusObservation(result, main);
  if (focus) out.push(focus);
  out.push(...backgroundObservations(persons, main));
  const direction = faceDirection(result, main);
  if (direction) out.push(direction);
  out.push(...gestureObservations(result, main, face));
  return out;
}

export const OBSERVATION_THRESHOLDS = Object.freeze({ RULE_CONFIDENCE, BACKGROUND_RATIO, EDGE_RATIO,
  SAME_SCALE_RATIO, GROUP_MAIN_HEIGHT, EDGE, FOCUS_FACE_HEIGHT, FOCUS_FACE_PIXELS, FOCUS_CLIPPED });
