import sharp from 'sharp';
import { createRequire } from 'node:module';
import { skyExposure } from './metrics.js';

export const CANDIDATE_CONFIG = createRequire(import.meta.url)('./candidate-config.json');
const average = a => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
const deviation = a => { const m = average(a); return Math.sqrt(average(a.map(v => (v - m) ** 2))); };
const inBox = (x, y, b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3];
export function candidatePerson(signals, c = CANDIDATE_CONFIG.person) {
  return signals?.persons?.filter(p => p.isMain && Number.isFinite(p.score) && p.score >= c.score &&
    Array.isArray(p.box) && p.box.length === 4 && p.box.every(Number.isFinite))
    .find(p => {
      const [a, b, d, e] = p.box, area = (d - a) * (e - b);
      return d > a && e > b && a >= c.margin && b >= 0 && d <= 1 - c.margin && e <= 1 &&
        area >= c.minArea && area <= c.maxArea;
    });
}

/** Pure small-raster measurements. Bounding-box sides are a spatial proxy,
 * not semantic hair/clothing segmentation; intent is never inferred. */
export function candidatePixels(data, width, height, { metrics = {}, faces = [], signals } = {}, c = CANDIDATE_CONFIG) {
  if (data.length !== width * height * 3 || width < 16 || height < 16) throw new Error('Invalid RGB candidate raster');
  const luma = Array.from({ length: width * height }, (_, i) =>
    .2126 * data[3 * i] + .7152 * data[3 * i + 1] + .0722 * data[3 * i + 2]);
  const mean = average(luma), range = quantile(luma, c.tonal.highPercentile) - quantile(luma, c.tonal.lowPercentile);
  const local = [];
  for (let y = 0; y < height; y += c.tonal.tileSize) for (let x = 0; x < width; x += c.tonal.tileSize) {
    const tile = [];
    for (let yy = y; yy < Math.min(height, y + c.tonal.tileSize); yy++)
      for (let xx = x; xx < Math.min(width, x + c.tonal.tileSize); xx++) tile.push(luma[yy * width + xx]);
    local.push(deviation(tile));
  }
  const tonal = { mean, range, localContrast: quantile(local, .5), eligible: true };
  if (mean < c.tonal.lowMean || mean > c.tonal.highMean) Object.assign(tonal, { eligible: false, reason: '夜景/低调/高调亮度保护' });
  if (Number.isFinite(metrics.quality) && metrics.quality > c.tonal.qualityProtectAbove)
    Object.assign(tonal, { eligible: false, reason: '高 TOPIQ 保护；柔和影调意图需复核' });
  const person = candidatePerson(signals, c.person);
  const highlights = { eligible: false, reason: '无可靠且侧边可采样的人物框；不定位非面部主体附近高光' };
  const separation = { eligible: false, reason: '无可靠且侧边可采样的人物框；框边不代表真实轮廓' };
  if (person) {
    const box = person.box, dx = box[2] - box[0], dy = box[3] - box[1];
    const region = [box[0] - dx * c.highlights.expandBox, box[1] - dy * c.highlights.expandBox,
      box[2] + dx * c.highlights.expandBox, box[3] + dy * c.highlights.expandBox];
    const mask = skyExposure(luma, width, height, undefined, { includeMask: true }).mask;
    const faceBoxes = faces.filter(f => Array.isArray(f.box) && f.box.length === 4 && f.box.every(Number.isFinite) &&
      f.box[2] > f.box[0] && f.box[3] > f.box[1] &&
      (!Number.isFinite(f.confidence) || f.confidence >= c.highlights.faceConfidence)).map(f => f.box);
    let pixels = 0, clipped = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const nx = (x + .5) / width, ny = (y + .5) / height, i = y * width + x;
      if (!inBox(nx, ny, region) || mask[i] || faceBoxes.some(b => inBox(nx, ny, b))) continue;
      pixels++;
      if (luma[i] >= c.highlights.clip) clipped++;
    }
    Object.assign(highlights, { pixels, fraction: pixels ? clipped / pixels : null,
      eligible: pixels >= c.highlights.minPixels && mean <= c.tonal.highMean,
      reason: mean > c.tonal.highMean ? '高调/白背景保护' : '排除 sky-v1 与所有可靠面部 ROI 的扩展人物框' });
    const n = Math.max(1, Math.round(dx * width * c.separation.bandWidth));
    const search = Math.max(1, Math.round(dx * width * c.separation.searchWidth));
    const rgb = (x, y) => [0, 1, 2].map(ch => data[(y * width + x) * 3 + ch]);
    const lum = v => .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
    const diffs = [], inside = [], outside = [];
    for (const side of [0, 2]) for (let k = 0; k < c.separation.positions; k++) {
      const y = Math.floor((box[1] + dy * (c.separation.start + (c.separation.end - c.separation.start) * k /
        (c.separation.positions - 1))) * height);
      const x0 = Math.round(box[side] * width), sign = side === 0 ? 1 : -1;
      let best;
      for (let shift = -search; shift <= search; shift++) {
        const x = x0 + shift;
        if (x - n < 0 || x + n >= width || y < 0 || y >= height) continue;
        const a = [0, 1, 2].map(ch => average(Array.from({ length: n }, (_, j) => rgb(x + sign * (j + 1), y)[ch])));
        const b = [0, 1, 2].map(ch => average(Array.from({ length: n }, (_, j) => rgb(x - sign * (j + 1), y)[ch])));
        const color = Math.sqrt(average(a.map((v, ch) => (v - b[ch]) ** 2))), delta = Math.abs(lum(a) - lum(b));
        if (!best || color > best.color) best = { color, delta, a: lum(a), b: lum(b) };
      }
      if (best) { diffs.push(best); inside.push(best.a); outside.push(best.b); }
    }
    if (diffs.length) {
      const silhouette = average(inside) < c.separation.darkSubject &&
        average(outside) - average(inside) > c.separation.silhouetteDifference;
      Object.assign(separation, { samples: diffs.length, lumaDifference: average(diffs.map(d => d.delta)),
        colorDifference: average(diffs.map(d => d.color)),
        weakFraction: diffs.filter(d => d.delta < c.separation.weakLuma && d.color < c.separation.weakColor).length / diffs.length,
        eligible: diffs.length >= c.separation.minSamples && !silhouette && mean >= c.tonal.lowMean && mean <= c.tonal.highMean,
        reason: silhouette ? '剪影保护' : mean < c.tonal.lowMean || mean > c.tonal.highMean ? '低调/高调保护' : '人物框侧边局部最强边缘带；非语义轮廓' });
    }
  }
  return { version: c.version, tonal, highlights, separation };
}

export async function measureCandidates(file, context = {}) {
  const { data, info } = await sharp(file).rotate().resize({ width: CANDIDATE_CONFIG.sampleSize,
    height: CANDIDATE_CONFIG.sampleSize, fit: 'inside' }).removeAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });
  return candidatePixels(data, info.width, info.height, context);
}

export function evaluateCandidateRules(m, signals, c = CANDIDATE_CONFIG) {
  const row = (ruleId, verdict, evidence) => ({ contractVersion: 1, ruleId, rulesVersion: `portrait-candidates@${c.version}`,
    verdict, by: 'measure', severity: 'hint', experiment: true, evidence: `${evidence}；实验提示，需人工复核意图；不进排序/gate` });
  if (m?.version !== c.version) return [];
  const t = m.tonal || {}, h = m.highlights || {}, s = m.separation || {};
  const tonal = !t.eligible || ![t.mean,t.range,t.localContrast].every(Number.isFinite)
    ? 'na' : t.range < c.tonal.violateRange && t.localContrast < c.tonal.violateLocal ? 'violate' :
    t.range < c.tonal.warnRange && t.localContrast < c.tonal.warnLocal ? 'warn' : 'pass';
  const highlight = !h.eligible || !Number.isFinite(h.fraction) || h.fraction < 0 || h.fraction > 1
    ? 'na' : h.fraction > c.highlights.violateFraction ? 'violate' :
    h.fraction > c.highlights.warnFraction ? 'warn' : 'pass';
  const separation = !s.eligible || !Number.isFinite(s.weakFraction) || s.weakFraction < 0 || s.weakFraction > 1
    ? 'na' : s.weakFraction > c.separation.violateWeakFraction ? 'violate' :
    s.weakFraction > c.separation.warnWeakFraction ? 'warn' : 'pass';
  const i = signals?.imageMeasurements;
  const angles = i?.version === 'measure-v3' ? ['horizontal', 'vertical'].filter(axis =>
    Number.isFinite(i[`${axis}TiltDegrees`]) && Math.abs(i[`${axis}TiltDegrees`]) <= c.tilt.maxDegrees &&
    i[`${axis}LineConfidence`] >= c.tilt.confidence).map(axis => Math.abs(i[`${axis}TiltDegrees`])) : [];
  const tilt = !angles.length ? 'na' : Math.max(...angles) > c.tilt.violateDegrees ? 'violate' :
    Math.max(...angles) > c.tilt.warnDegrees ? 'warn' : 'pass';
  return [row('P-YD-TONAL-GRAY', tonal, JSON.stringify(t)), row('P-YD-TILT', tilt,
    `复用 ${c.tilt.mapping.join('/')}；可靠角度 ${JSON.stringify(angles)}°`),
  row('P-YD-NONFACE-HIGHLIGHTS', highlight, JSON.stringify(h)), row('P-YD-BG-SEPARATION', separation, JSON.stringify(s))];
}
