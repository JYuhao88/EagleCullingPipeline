// Upright normalized coordinates, shared by native focus and the 1:1 viewer.
export const EYE_ROI_VERSION = 'eye-roi-v1';
const valid = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)
  && b.every(x => x >= 0 && x <= 1) && b[2] > b[0] && b[3] > b[1];
const contains = (b, p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const bounds = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
  Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
function eye(points) {
  if (points.length !== 6 || points.some(p => !Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)
    || p[2] < .5 || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1)) return null;
  const b = bounds(points), span = b[2] - b[0];
  if (span < .001 || span > .15) return null;
  const pad = span * .25;
  const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad].map(x => Math.max(0, Math.min(1, x)));
  return valid(box) ? box : null;
}
export function completeEyeRois(faces = [], persons = []) {
  const output = (Array.isArray(faces) ? faces : []).map(f => ({ ...f }));
  for (const person of Array.isArray(persons) ? persons : []) {
    const points = person?.keypoints?.points;
    if (!Array.isArray(points) || points.length < 91 || (Number.isFinite(person.score) && person.score < .5)) continue;
    const eyes = [eye(points.slice(59, 65)), eye(points.slice(65, 71))];
    if (eyes.some(b => !b)) continue;
    const centers = eyes.map(b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    const matches = output.filter(f => valid(f.box) && centers.every(p => contains(f.box, p)));
    // Ambiguous overlap must not attach another person's eyes to a face.
    if (matches.length > 1) continue;
    let face = matches[0];
    if (!face) {
      const contour = points.slice(23, 91);
      if (contour.some(p => !Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite) || p[2] < .5)) continue;
      const box = bounds(contour);
      if (!valid(box) || !valid(person.box) || !centers.every(p => contains(person.box, p))) continue;
      // Do not invent blink scores for a pose-derived face.
      face = { box, eyesAssessed: false, eyesClosed: false, roiSource: 'rtmw-face' };
      output.push(face);
    }
    if (valid(face.eyeBox) || valid(face.eyesBox)) continue;
    const existing = face.eyes || face.eyeBoxes;
    if (Array.isArray(existing) && existing.some(b => valid(b?.box || b))) continue;
    face.eyeBoxes = eyes;
    face.eyeRoiSource = 'rtmw-68';
    face.eyeRoiConfidence = Math.min(...points.slice(59, 71).map(p => p[2]));
  }
  return output;
}
// Cached results store completed ROIs; detector-stage consumers must see detector faces only.
export function detectorFaces(faces = []) {
  return (Array.isArray(faces) ? faces : []).filter(f => f?.roiSource !== 'rtmw-face').map(f => {
    if (f?.eyeRoiSource !== 'rtmw-68') return f;
    const { eyeBoxes, eyeRoiSource, eyeRoiConfidence, ...face } = f;
    return face;
  });
}
