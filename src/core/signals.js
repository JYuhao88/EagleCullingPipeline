// COCO WholeBody: body 0..16, feet 17..22, face 23..90, hands 91..132.
export const SIGNAL_THRESHOLDS = Object.freeze({ confidence: 0.3, edgeHeads: 0.15, compressedShinRatio: 0.8,
  kneeBorderConfidence: 0.75, neckEdgeHeads: 0.15 });
const good = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite) && p[2] >= SIGNAL_THRESHOLDS.confidence;
const valid = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);
const inside = (p) => good(p) && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
const mean = (ps) => {
  const available = ps.filter(good);
  return available.length ? [0, 1, 2].map((i) => available.reduce((sum, p) => sum + p[i], 0) / available.length) : undefined;
};
const round = (v) => Math.round(v * 10000) / 10000;
function lineAngle(a, b, aspect) {
  if (!good(a) || !good(b)) return undefined;
  // Orient each line from screen left to right; anatomical left/right swaps do not change tilt.
  const [l, r] = a[0] <= b[0] ? [a, b] : [b, a];
  const dx = (r[0] - l[0]) * aspect, dy = r[1] - l[1];
  if (Math.hypot(dx, dy) < 0.005) return undefined;
  return round(Math.atan2(dy, dx) * 180 / Math.PI);
}
// RTMW can squeeze a whole missing lower limb into the last image rows with
// deceptively high scores. A severely collapsed shin at the lower border does
// not establish the knee/ankle/foot location; treat that chain as unobservable.
// This is a measurement validity guard, not a foreshortening/aesthetic verdict.
export function measurementPoints(person, aspect = 1, thresholds = SIGNAL_THRESHOLDS) {
  const points = (person.keypoints?.points || []).map((p) => [...p]);
  const length = (a, b) => Math.hypot((a[0]-b[0])*aspect, a[1]-b[1]);
  const brow = mean([points[44], points[45]]), chin = points[31];
  const head = brow && good(chin) ? 1.65*(chin[1]-brow[1]) : undefined;
  for (const [hip,knee,ankle,foot] of [[11,13,15,17],[12,14,16,20]]) {
    const h=points[hip], k=points[knee], a=points[ankle];
    if (![h,k,a].every(inside) || k[1] < .85 || a[1] < .9 || a[1] < k[1] - .05) continue;
    const thigh=length(h,k), shin=length(k,a);
    const reversedAtBorder = a[1] < k[1] && k[1]-a[1] < .04 && k[1]-h[1] > .05;
    const coherentBentLeg = head > .015 && k[2] >= .8 && a[2] >= .8 && shin > .8*head;
    if (thigh > .05 && !coherentBentLeg && (shin < thresholds.compressedShinRatio*thigh || reversedAtBorder)) {
      // A high-confidence knee at the border can remain localized even when
      // the missing shin collapses. Keep that knee; invalidate distal predictions.
      const keepKnee = head > .015 && k[2] >= thresholds.kneeBorderConfidence &&
        Math.abs(1-k[1]) < thresholds.edgeHeads*head;
      for (const index of [knee,ankle,foot,foot+1,foot+2]) {
        if (points[index] && !(index === knee && keepKnee)) points[index][2]=0;
      }
    }
  }
  return points;
}
function measurePerson(person, aspect, thresholds) {
  const p = measurementPoints(person, aspect, thresholds);
  const result = { box: person.box, score: person.score, isMain: Boolean(person.isMain), keypoints: person.keypoints ? {
    ...person.keypoints, points: person.keypoints.points.map((point) => [Math.max(0, Math.min(1, point[0])), Math.max(0,
    Math.min(1, point[1])), point[2]]) } : undefined };
  const brow = mean([p[44], p[45]]), chin = good(p[31]) ? p[31] : undefined;
  // Hairline is not a landmark. Assume its position is 0.65 brow-to-chin vectors
  // above the inner-brow midpoint. Hair volume/hat height are deliberately not inferred.
  const hairline = brow && chin && chin[1] > brow[1]
    ? [brow[0] + 0.65 * (brow[0] - chin[0]), brow[1] + 0.65 * (brow[1] - chin[1]), Math.min(brow[2], chin[2])] : undefined;
  const faceHeadHeight = hairline ? chin[1] - hairline[1] : undefined;
  const shoulders = mean([p[5], p[6]]);
  const clippedFaceTop = inside(p[5]) && inside(p[6]) &&
    ((valid(p[44]) && p[44][1] < 0) || (valid(p[45]) && p[45][1] < 0) || (valid(chin) && chin[1] < 0));
  const shoulderSpan = inside(p[5]) && inside(p[6]) ? Math.hypot((p[5][0]-p[6][0])*aspect, p[5][1]-p[6][1]) : undefined;
  // A face squeezed against the top edge cannot supply head scale. Use an
  // explicit shoulder-derived estimate for border units/neck, no hairline/headroom.
  const headHeight = clippedFaceTop && shoulderSpan > .02 ? shoulderSpan*.6 : faceHeadHeight;
  const neck = clippedFaceTop && shoulders && headHeight
    ? [shoulders[0], shoulders[1]-.35*headHeight, shoulders[2]]
    : shoulders && chin ? [(shoulders[0]+chin[0])/2, (shoulders[1]+chin[1])/2, Math.min(shoulders[2], chin[2])] : undefined;
  if (headHeight && headHeight >= 0.015 && headHeight <= 0.8) {
    result.headHeight = round(headHeight);
    if (clippedFaceTop) result.headScaleSource = 'shoulder-estimate';
    else if (hairline) result.headroomHeads = round(hairline[1] / headHeight);
    const warnings = [];
    const add = (point, adjacent, joint, side) => {
      const adjacentNear = good(adjacent) && adjacent[0] >= -.005*headHeight/aspect &&
        adjacent[0] <= 1+.005*headHeight/aspect && adjacent[1] >= -.005*headHeight && adjacent[1] <= 1+.005*headHeight;
      if (!valid(point) || !adjacentNear) return;
      const distances = { top: point[1], bottom: 1 - point[1], left: point[0] * aspect, right: (1 - point[0]) * aspect };
      for (const [edge, distance] of Object.entries(distances)) {
        // Reliable out-of-frame points follow the contract's outside-or-near
        // condition. Weak predictions need a narrow edge band and a visible
        // neighbour; interior occlusion and distant weak hallucinations are na.
        const band = joint === 'neck' && clippedFaceTop ? thresholds.neckEdgeHeads : thresholds.edgeHeads;
        const near = Math.abs(distance) / headHeight < band - 1e-10;
        if (!near && !(good(point) && distance < 0)) continue;
        if (point[2] <= 0 || (['foot', 'fingers'].includes(joint) && !good(point))) continue;
        if (warnings.some((w) => w.edge === edge && w.joint === joint && w.side === side)) continue;
        warnings.push({ edge, joint, distanceHeads: round(distance / headHeight), ...(side ? { side } : {}) });
      }
    };
    if (!clippedFaceTop) add(hairline, brow, 'hairline');
    add(neck, clippedFaceTop ? shoulders : chin, 'neck');
    for (const [side, shoulder, elbow, wrist, hip, knee, ankle, foot, hand] of [
      ['left', 5, 7, 9, 11, 13, 15, 17, 91], ['right', 6, 8, 10, 12, 14, 16, 20, 112],
    ]) {
      add(p[elbow], p[shoulder], 'elbow', side);
      add(p[wrist], p[elbow], 'wrist', side);
      add(p[knee], p[hip], 'knee', side);
      add(p[ankle], p[knee], 'ankle', side);
      for (let i = foot; i < foot + 3; i++) add(p[i], p[ankle], 'foot', side);
      for (const finger of [4, 8, 12, 16, 20]) add(p[hand + finger], p[hand + finger - 1], 'fingers', side);
    }
    result.jointObservability = {
      hairline: !clippedFaceTop && inside(brow) && inside(chin), neck: !clippedFaceTop && inside(chin) && inside(p[5]) && inside(p[6]),
      elbow: [5, 6, 7, 8].every((i) => inside(p[i])), wrist: [7, 8, 9, 10].every((i) => inside(p[i])),
      knee: [11, 12, 13, 14].every((i) => inside(p[i])), ankle: [13, 14, 15, 16].every((i) => inside(p[i])),
      foot: [15, 16, 17, 18, 19, 20, 21, 22].every((i) => inside(p[i])),
      fingers: [95, 99, 103, 107, 111, 116, 120, 124, 128, 132].every((i) => inside(p[i])),
    };
    result.edgeAtJoint = warnings;
    result.handsTruncated = warnings.filter((w) => ['wrist', 'fingers'].includes(w.joint))
      .filter((w, i, all) => all.findIndex((other) => other.side === w.side && other.edge === w.edge) === i)
      .map(({ side, edge }) => ({ side, edge }));
    const hips = mean([p[11], p[12]]), knees = mean([p[13], p[14]]);
    const feet = [p[17], p[18], p[19], p[20], p[21], p[22]];
    if (warnings.some((w) => w.edge === 'bottom' && w.joint === 'knee' && Math.abs(w.distanceHeads) <
      thresholds.edgeHeads)) result.framingTier = 'knee-cut';
    else if (feet.every(inside) && inside(p[15]) && inside(p[16]) && !warnings.some((w) => w.edge === 'bottom' && ['ankle',
      'foot'].includes(w.joint))) result.framingTier = 'full';
    else if (shoulders && hips && hips[1] > shoulders[1] && 1 >= shoulders[1] && 1 < hips[1]) {
      result.framingTier = (1 - shoulders[1]) / (hips[1] - shoulders[1]) < 0.55 ? 'chest' : 'waist';
    } else if (hips && knees && knees[1] > hips[1] && 1 >= hips[1] && 1 < knees[1]) result.framingTier = 'thigh';
    else if (knees && shoulders && hips) result.framingTier = 'other';
  }
  const shoulderTilt = lineAngle(p[5], p[6], aspect), hipTilt = lineAngle(p[11], p[12], aspect);
  if (shoulderTilt !== undefined) result.shoulderTilt = shoulderTilt;
  if (hipTilt !== undefined) result.hipTilt = hipTilt;
  if (shoulderTilt !== undefined && hipTilt !== undefined) {
    const difference = Math.abs(shoulderTilt - hipTilt);
    result.shoulderHipAngle = round(Math.min(difference, 180 - difference));
  }
  return result;
}

export function computeSignals(poseResult, { source, thresholds = SIGNAL_THRESHOLDS } = {}) {
  const width = poseResult?.width ?? poseResult?.source?.proxyWidth, height = poseResult?.height ?? poseResult?.source?.proxyHeight;
  source = source ?? poseResult?.source;
  const aspect = width > 0 && height > 0 ? width / height : 1;
  const signals = { contractVersion: 1, persons: (poseResult?.persons || []).map((person) => measurePerson(person, aspect, thresholds)) };
  if (source || (width > 0 && height > 0)) {
    signals.source = { ...(source || { width, height, kind: 'jpeg' }), ...(width > 0 ? { proxyWidth: width } : {}), ...(height > 0
      ? { proxyHeight: height } : {}) };
  }
  const image = poseResult?.imageMeasurements;
  signals.imageMeasurements = { version: MEASURE_VERSION, ...(image || {}) };
  delete signals.imageMeasurements.faceExposures;
  for (const [index, person] of signals.persons.entries()) {
    if (image?.faceExposures?.[index]) Object.assign(person, image.faceExposures[index]);
    if (Array.isArray(person.box) && person.box.length === 4 && person.box.every(Number.isFinite)) {
      const [x0, y0, x1, y1] = person.box;
      if (x1 > x0 && y1 > y0 && x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1) {
        const cx = (x0+x1)/2, cy = (y0+y1)/2;
        person.subjectAreaRatio = round((x1-x0)*(y1-y0));
        person.subjectCenterDistance = round(Math.hypot(cx-.5, cy-.5)/Math.SQRT2);
        person.subjectThirdsDistance = round(Math.min(...[1/3, 2/3].flatMap((x) =>
          [1/3, 2/3].map((y) => Math.hypot(cx-x, cy-y))))/Math.SQRT2);
        person.subjectAnchorDistance = Math.min(person.subjectCenterDistance, person.subjectThirdsDistance);
      }
    }
  }
  return signals;
}

export const MEASURE_VERSION = 'measure-v3';
// These are proxy measurements, never RAW recoverability or native eye focus.
export function pixelMeasurements(data, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 ||
    data.length !== width * height * 3) throw new Error('Expected RGB proxy pixels');
  const count = width * height, gray = new Float32Array(count), sums = [0, 0, 0];
  let highlights = 0, shadows = 0, usable = 0, lapSum = 0, lapSquare = 0;
  let borderGradient = 0, centerGradient = 0, borderCount = 0, centerCount = 0;
  const lines = [];
  for (let i = 0; i < count; i++) {
    const r = data[3*i], g = data[3*i+1], b = data[3*i+2];
    gray[i] = .2126*r + .7152*g + .0722*b;
    if (Math.max(r, g, b) >= 252) highlights++;
    if (gray[i] <= 3) shadows++;
    if (gray[i] > 15 && gray[i] < 240) { usable++; sums[0] += r; sums[1] += g; sums[2] += b; }
  }
  const band = Math.max(2, Math.round(Math.min(width, height) * .06));
  for (let y = 1; y < height-1; y++) for (let x = 1; x < width-1; x++) {
    const i = y*width+x, dx = (gray[i+1]-gray[i-1])/2, dy = (gray[i+width]-gray[i-width])/2;
    const gradient = Math.hypot(dx, dy);
    const lap = gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width]-4*gray[i];
    lapSum += lap; lapSquare += lap*lap;
    if (x < band || x >= width-band || y < band || y >= height-band) { borderGradient += gradient; borderCount++; }
    else { centerGradient += gradient; centerCount++; }
    // A sampled, oriented edge set bounds Hough work independently of resolution.
    if (gradient >= 20 && x % 2 === 0 && y % 2 === 0) lines.push({ x, y, dx, dy, gradient });
  }
  const inner = (width-2)*(height-2), edgeMean = borderGradient / Math.max(1, borderCount);
  const centerMean = centerGradient / Math.max(1, centerCount);
  const result = { version: MEASURE_VERSION, proxyWidth: width, proxyHeight: height,
    clippedHighlights: round(highlights/count), clippedShadows: round(shadows/count),
    laplacianVariance: round(Math.max(0, lapSquare/inner-(lapSum/inner)**2)),
    edgeGradientMean: round(edgeMean), centerGradientMean: round(centerMean),
    edgeGradientRatio: round(edgeMean / Math.max(1, centerMean)),
    grayWorldPixels: usable };
  if (usable >= 64 && Math.max(...sums) > 0) {
    result.grayWorldDeviation = round((Math.max(...sums)-Math.min(...sums)) / Math.max(...sums));
    result.channelMeans = sums.map((v) => round(v/usable));
  }
  // Line candidates only. Without semantic horizon/building recognition these can only warn.
  const horizontal = houghAxis(lines, width, height, false), vertical = houghAxis(lines, width, height, true);
  if (horizontal) Object.assign(result, { horizontalTiltDegrees: horizontal.angle,
    horizontalLineConfidence: horizontal.confidence, horizontalSegments: horizontal.segments });
  if (vertical) Object.assign(result, { verticalTiltDegrees: vertical.angle,
    verticalLineConfidence: vertical.confidence, verticalSegments: vertical.segments });
  return result;
}

function houghAxis(points, width, height, vertical) {
  points = points.filter((p) => vertical ? Math.abs(p.dx) > Math.abs(p.dy)*2 : Math.abs(p.dy) > Math.abs(p.dx)*2);
  const stride = Math.max(1, Math.ceil(points.length/2500));
  points = points.filter((_, i) => i % stride === 0);
  if (points.length < 12) return undefined;
  const axisLength = vertical ? height : width, crossLength = vertical ? width : height;
  const offset = Math.ceil(axisLength*.23), bins = crossLength + 2*offset + 1;
  const candidates = [];
  for (let angle = -12; angle <= 12; angle += .5) {
    const slope = Math.tan(angle*Math.PI/180), votes = new Uint16Array(bins);
    for (const p of points) {
      const u = vertical ? p.y : p.x, v = vertical ? p.x : p.y;
      const rho = Math.round(v-slope*u)+offset;
      if (rho >= 0 && rho < bins) votes[rho]++;
    }
    for (let rho = 1; rho < bins-1; rho++) {
      if (votes[rho] >= 8 && votes[rho] >= votes[rho-1] && votes[rho] > votes[rho+1]) {
        candidates.push({ angle, rho: rho-offset, votes: votes[rho] });
      }
    }
  }
  candidates.sort((a, b) => b.votes-a.votes);
  const segments = [];
  for (const c of candidates) {
    if (segments.some((s) => Math.abs(s.rho-c.rho) < 5 && Math.abs(s.angle-c.angle) < 2)) continue;
    const slope = Math.tan(c.angle*Math.PI/180), support = points.filter((p) => {
      const u = vertical ? p.y : p.x, v = vertical ? p.x : p.y;
      return Math.abs(v-slope*u-c.rho) <= 1.5;
    });
    const us = support.map((p) => vertical ? p.y : p.x), vs = support.map((p) => vertical ? p.x : p.y);
    const lo = Math.min(...us), hi = Math.max(...us), span = (hi-lo)/axisLength;
    const occupancy = new Set(us.map((u) => Math.floor((u-lo)/8))).size / Math.max(1, Math.ceil((hi-lo)/8));
    if (span < .35 || occupancy < .45) continue;
    const n = us.length, mu = us.reduce((s, v) => s+v, 0)/n, mv = vs.reduce((s, v) => s+v, 0)/n;
    const covariance = us.reduce((s, v, i) => s+(v-mu)*(vs[i]-mv), 0);
    const variance = us.reduce((s, v) => s+(v-mu)**2, 0);
    if (variance <= 0) continue;
    const angle = Math.atan(covariance/variance)*180/Math.PI;
    segments.push({ angle: round(angle), rho: c.rho, span: round(span), support: n, occupancy: round(occupancy) });
    if (segments.length >= 6) break;
  }
  if (!segments.length) return undefined;
  const sorted = [...segments].sort((a, b) => a.angle-b.angle);
  const total = sorted.reduce((s, v) => s+v.support*v.span, 0);
  let sum = 0, angle = sorted[0].angle;
  for (const s of sorted) { sum += s.support*s.span; if (sum >= total/2) { angle = s.angle; break; } }
  const agreeing = segments.filter((s) => Math.abs(s.angle-angle) < 1.5);
  const consistent = agreeing.reduce((s, v) => s+v.support*v.span, 0)/total;
  const longest = Math.max(...agreeing.map((s) => s.span));
  const confidence = consistent * Math.min(1, longest/.65) * (agreeing.length >= 2 ? 1 : .8);
  if (confidence < .65) return undefined;
  return { angle: round(angle), confidence: round(confidence), segments };
}

export async function computeProxyMeasurements(filePath, { faces = [], persons = [] } = {}) {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(filePath).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const result = pixelMeasurements(data, info.width, info.height);
  result.faceExposures = persons.map((person) => {
    if (!Array.isArray(person.box)) return undefined;
    const [x0, y0, x1, y1] = person.box;
    const candidates = faces.filter((face) => Array.isArray(face.box) && face.box.length === 4 &&
      face.box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && face.box[2] > face.box[0] && face.box[3] > face.box[1])
      .filter(({ box: b }) => (b[0]+b[2])/2 >= x0 && (b[0]+b[2])/2 <= x1 && (b[1]+b[3])/2 >= y0 && (b[1]+b[3])/2 <= y1)
      .sort((a, b) => (b.box[2]-b.box[0])*(b.box[3]-b.box[1])-(a.box[2]-a.box[0])*(a.box[3]-a.box[1]));
    if (!candidates.length) return undefined;
    const b = candidates[0].box;
    // Inner face box reduces hair/background leakage; still a box proxy, not a skin mask.
    const left = Math.max(0, Math.ceil((b[0]+(b[2]-b[0])*.15)*info.width));
    const right = Math.min(info.width, Math.floor((b[2]-(b[2]-b[0])*.15)*info.width));
    const top = Math.max(0, Math.ceil((b[1]+(b[3]-b[1])*.15)*info.height));
    const bottom = Math.min(info.height, Math.floor((b[3]-(b[3]-b[1])*.15)*info.height));
    const count = Math.max(0, right-left)*Math.max(0, bottom-top);
    if (count < 64 || right-left < 8 || bottom-top < 8) return undefined;
    let high = 0, low = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y*info.width+x)*3, r = data[i], g = data[i+1], blue = data[i+2];
      if (Math.max(r, g, blue) >= 252) high++;
      if (.2126*r+.7152*g+.0722*blue <= 15) low++;
    }
    return { faceClippedHighlights: round(high/count), faceClippedShadows: round(low/count), faceExposurePixels: count };
  });
  return result;
}
