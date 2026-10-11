import { measurementPoints } from './signals.js';
import { assessClosedEyes } from './eye-assessment.js';
import { readFileSync, readdirSync } from 'node:fs';
import { evaluateCandidateRules } from './candidate-measurements.js';

const rulesDirectory = new URL('../rules/', import.meta.url);
const libraries = readdirSync(rulesDirectory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, rulesDirectory), 'utf8')));
const unsupported = new Set(['eyeSharpnessNative', 'afPointOnEye', 'limbForeshortening', 'limbOcclusion', 'faceClippedHighlights',
  'faceClippedShadows']);
const edgeNames = { top: '上沿', bottom: '下沿', left: '左沿', right: '右沿' };
const jointNames = { hairline: '发际线', neck: '脖颈', wrist: '腕', fingers: '手指', elbow: '肘', knee: '膝', ankle: '踝', foot: '脚' };
const tierNames = { chest: '胸像', waist: '半身像', thigh: '七分像', full: '全身像', 'knee-cut': '膝部裁切', other: '其他景别' };
const jointPoints = { hairline: [23, 26, 27, 30, 31, 38], neck: [5, 6], elbow: [7, 8], wrist: [9, 10, 91, 112],
  fingers: [95, 99, 103, 107, 111,
  116, 120, 124, 128, 132], knee: [13, 14], ankle: [15, 16], foot: [17, 18, 19, 20, 21, 22] };
const finite = Number.isFinite;
const number = (value) => value.toFixed(2);

function measurableJoint(person, joint, aspect) {
  // The calibrated signal distinguishes observed safe joints from hidden or
  // compressed predictions. Do not fabricate a pass from one visible side.
  if (person.jointObservability && Object.hasOwn(person.jointObservability, joint))
    return person.jointObservability[joint] === true;
  const points = measurementPoints(person, aspect);
  if (joint === 'hairline' && finite(person.headHeight) && person.headHeight > 0) return true;
  return (jointPoints[joint] || []).some((index) => {
    const point = points[index];
    return point && point.slice(0, 3).every(finite) && point[2] >= 0.3;
  });
}

function thresholdCheck(measure, person, imageMeasurements) {
  if (measure.version !== 'measure-v3' || imageMeasurements?.version !== measure.version)
    return ['na', '缺少当前版本的代理图测量'];
  const source = measure.scope === 'image' ? imageMeasurements : person;
  if (!source) return ['na', '未检测到可测量的主体人物'];
  for (const requirement of measure.requires || []) {
    if (!finite(source[requirement.signal]) || source[requirement.signal] < requirement.min)
      return ['na', `${requirement.signal} 不足 ${requirement.min}；${measure.version}`];
  }
  const conditions = measure.conditions || [];
  if (!conditions.length || conditions.some(({ signal, min, max }) => !finite(source[signal]) ||
    (finite(min) && source[signal] < min) || (finite(max) && source[signal] > max)))
    return ['na', `缺少可靠数值测量；${measure.version}`];
  const operations = { gt: (a, b) => a > b, lt: (a, b) => a < b, absGt: (a, b) => Math.abs(a) > b };
  if (conditions.some(({ op, threshold }) => !operations[op] || !finite(threshold)))
    return ['na', `不支持的测量配置；${measure.version}`];
  const triggered = conditions.some(({ signal, op, threshold }) => operations[op](source[signal], threshold));
  const evidence = conditions.map(({ signal, op, threshold, units }) =>
    `${signal}=${source[signal].toFixed(4)} ${units || ''}（${op} ${threshold}）`).join('，');
  // Proxy heuristics cannot establish intent. Explicit severe checks may
  // penalize group preference; ordinary hints remain warn and never gate.
  const severe = (measure.violateConditions || []).some(({ signal, op, threshold }) =>
    finite(source[signal]) && operations[op]?.(source[signal], threshold));
  return [severe ? 'violate' : triggered ? 'warn' : 'pass', `${evidence}；${measure.version}`];
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function relativeHeadroom(measure, person, imageMeasurements, groupSignals) {
  if (imageMeasurements?.version !== measure.version || !finite(person?.headroomHeads) || !person.framingTier)
    return ['na', '缺少当前版本的头顶留白或景别测量'];
  // Compare one value per image, so a crowd cannot dominate the group baseline.
  const values = (groupSignals || []).filter((signals) => signals?.imageMeasurements?.version === measure.version)
    .map((signals) => (signals.persons || []).filter((p) => p.isMain && p.framingTier === person.framingTier &&
      finite(p.headroomHeads) && p.headroomHeads >= 0).map((p) => p.headroomHeads))
    .filter((v) => v.length).map(median);
  if (values.length < measure.minGroupSamples) return ['na', '同组同景别的可靠留白样本不足'];
  const baseline = median(values);
  const threshold = Math.max(measure.absoluteAbove, baseline + measure.deltaHeads, baseline * measure.ratioAbove);
  return [person.headroomHeads > threshold ? 'warn' : 'pass',
    `头顶留白 ${number(person.headroomHeads)} 头高，同组${tierNames[person.framingTier] || person.framingTier}` +
    `中位数 ${number(baseline)}（${values.length} 张），提示门槛 ${number(threshold)}；${measure.version}`];
}

function colorSample(image, measure) {
  if (image?.version !== measure.version || image.grayWorldPixels < measure.minPixels ||
      !finite(image.grayWorldPixels) || !finite(image.grayWorldDeviation) || !Array.isArray(image.channelMeans) ||
      image.channelMeans.length !== 3 || !image.channelMeans.every((v) => finite(v) && v >= 0 && v <= 255)) return;
  const [r, g, b] = image.channelMeans;
  const luma = .2126 * r + .7152 * g + .0722 * b;
  if (luma < measure.minLuma || (r > g * measure.warmRedRatio && b < g * measure.warmBlueRatio)) return;
  const max = Math.max(r, g, b);
  return max > 0 ? image.channelMeans.map((v) => v / max) : undefined;
}

function relativeColor(measure, imageMeasurements, groupSignals) {
  const sample = colorSample(imageMeasurements, measure);
  if (!sample) return ['na', '灰世界测量不足、低亮度或暖光场景；不推断偏色错误'];
  const samples = (groupSignals || []).map((s) => colorSample(s?.imageMeasurements, measure)).filter(Boolean);
  if (samples.length < measure.minGroupSamples) return ['na', '同组可靠色彩对照不足'];
  const baseline = [0, 1, 2].map((channel) => median(samples.map((s) => s[channel])));
  const difference = Math.max(...sample.map((v, channel) => Math.abs(v - baseline[channel])));
  const triggered = imageMeasurements.grayWorldDeviation > measure.absoluteAbove && difference > measure.deltaAbove;
  return [triggered ? 'warn' : 'pass',
    `grayWorldDeviation=${imageMeasurements.grayWorldDeviation.toFixed(4)}，同组通道偏差 ${difference.toFixed(4)}` +
    `（>${measure.deltaAbove}，${samples.length} 张对照）；${measure.version}`];
}

function checkRule(rule, person, faces, aspect, imageMeasurements, groupSignals, eyeUnit, groupUnits) {
  if (rule.check.measure?.mode === 'relative-headroom')
    return relativeHeadroom(rule.check.measure, person, imageMeasurements, groupSignals);
  if (rule.check.measure?.mode === 'relative-color')
    return relativeColor(rule.check.measure, imageMeasurements, groupSignals);
  if (rule.check.measure?.mode === 'thresholds') return thresholdCheck(rule.check.measure, person, imageMeasurements);
  const signals = [].concat(rule.check.signal || []);
  if (signals.some((signal) => unsupported.has(signal))) return ['na', '尚无可靠测量信号'];
  if (!person) return ['na', '未检测到可测量的主体人物'];
  if (rule.check.signal === 'headroomHeads') {
    const value = person.headroomHeads;
    if (!finite(value)) return ['na', '头顶位置不可可靠测量'];
    const within = (range) => Array.isArray(range) && value >= range[0] && value <= range[1];
    const verdict = within(rule.check.pass) ? 'pass' : within(rule.check.warn) ? 'warn' : 'violate';
    const currentHint = rule.check.measure?.outcome === 'warn' && imageMeasurements?.version === rule.check.measure.version;
    return [currentHint && verdict === 'violate' ? 'warn' : verdict, `头顶留白 ${number(value)} 头高`];
  }
  if (rule.check.signal === 'edgeAtJoint') {
    if (!Array.isArray(person.edgeAtJoint)) return ['na', '缺少裁切测量信号'];
    const joints = [].concat(rule.check.joint);
    const hits = person.edgeAtJoint.filter((hit) => joints.includes(hit.joint) && (rule.check.edge === 'any' || hit.edge ===
      rule.check.edge));
    if (hits.length) {
      const hit = hits.reduce((a, b) => b.distanceHeads < a.distanceHeads ? b : a);
      const side = hit.side === 'left' ? '左' : hit.side === 'right' ? '右' : '';
      const joint = `${side}${jointNames[hit.joint] || hit.joint}`;
      return ['violate', finite(hit.distanceHeads) && hit.distanceHeads >= 0
        ? `${edgeNames[hit.edge]}距${joint} ${number(hit.distanceHeads)} 头高`
        : `${joint}越过${edgeNames[hit.edge]}`];
    }
    if (!joints.every((joint) => measurableJoint(person, joint, aspect))) return ['na', '相关关节不可可靠测量'];
    return ['pass', `${joints.map((joint) => jointNames[joint]).join('、')}未检出边缘裁切`];
  }
  if (rule.check.signal === 'framingTier') {
    if (typeof person.framingTier !== 'string') return ['na', '缺少景别测量信号'];
    return [rule.check.pass.includes(person.framingTier) ? 'pass' : 'violate', `景别：${tierNames[person.framingTier] || person.framingTier}`];
  }
  if (rule.check.signal === 'eyesClosed') {
    const assessment = assessClosedEyes({ ...eyeUnit, faces,
      signals: { ...eyeUnit?.signals, persons: [person] } }, groupUnits);
    return [assessment.gate ? 'violate' : assessment.warn ? 'warn' : assessment.assessed ? 'pass' : 'na', assessment.evidence];
  }
  if (signals.length === 3 && ['shoulderTilt', 'hipTilt', 'shoulderHipAngle'].every((signal) => signals.includes(signal) &&
    finite(person[signal]))) {
    // The library gives no numeric pose thresholds. Report measurements for
    // review; inventing a threshold would turn an aesthetic hint into a gate.
    return ['warn', `肩倾 ${number(person.shoulderTilt)}°，髋倾 ${number(person.hipTilt)}°，肩髋夹角 ${number(person.shoulderHipAngle)}°；需结合姿态判断`];
  }
  return ['na', '缺少可靠测量信号'];
}

/** Evaluate only the measurement part of each rule, for each main subject. */
export function evaluateRules(signals, { faces = [], rules = libraries, genres, groupSignals, groupUnits = [] } = {}) {
  const selected = Array.isArray(rules) ? rules : [rules];
  const mainPersons = (signals?.persons || []).map((person, personIndex) => ({ person, personIndex })).filter(({ person }) =>
    person.isMain === true);
  const subjects = mainPersons.length ? mainPersons : [{ person: undefined }];
  const genreList = genres === undefined ? undefined : [].concat(genres);
  const measured = selected.filter((library) => !genreList || library.genres?.some((genre) => genreList.includes(genre)))
    .flatMap((library) => (library.rules || []).filter((rule) => rule.check?.by?.split('+').includes('measure'))
      .flatMap((rule) => (rule.check.measure?.scope === 'image' ? [{}] : subjects).map(({ person, personIndex }) => {
    const aspect = (signals?.source?.proxyWidth || 1) / (signals?.source?.proxyHeight || 1);
    const [verdict, evidence] = checkRule(rule, person, faces, aspect, signals?.imageMeasurements, groupSignals, { signals }, groupUnits);
    return { contractVersion: 1, ruleId: rule.id, rulesVersion: `${library.library}@${library.version}`, verdict, by: 'measure',
      evidence, ...(personIndex === undefined ? {} : { personIndex }) };
  })));
  // Experimental pixels are opt-in; supplied formal libraries retain their
  // exact semantics. Candidate IDs are absent from ranking penalty mapping.
  return rules === libraries && (!genreList || genreList.includes('portrait'))
    ? measured.concat(evaluateCandidateRules(signals?.imageMeasurements?.candidates, signals)) : measured;
}
