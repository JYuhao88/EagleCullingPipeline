export const CONTRACT_VERSION = 1;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const finite = Number.isFinite;
const normalized = (v) => finite(v) && v >= 0 && v <= 1;
const optional = (v, key, check) => v !== null && typeof v === 'object' && (!(key in v) || check(v[key]));
const edges = ['top', 'bottom', 'left', 'right'];
const joints = ['hairline', 'neck', 'wrist', 'fingers', 'elbow', 'knee', 'ankle', 'foot'];
const sides = ['left', 'right'];
const sourceKinds = ['embedded-jpeg', 'decoded-raw', 'jpeg', 'heic'];
export function validateSignals(v) {
  if (!v || v.contractVersion !== 1 || !Array.isArray(v.persons)) return false;
  if (!optional(v, 'source', (s) => s && ['width', 'height', 'proxyWidth', 'proxyHeight'].every((key) => finite(s[key]) && s[key]
    > 0) && sourceKinds.includes(s.kind))) return false;
  for (const person of v.persons) {
    if (!person || !Array.isArray(person.box) || person.box.length !== 4 || !person.box.every(normalized) || person.box[0] >
      person.box[2] || person.box[1] > person.box[3] || !normalized(person.score) || typeof person.isMain !== 'boolean') return false;
    const kp = person.keypoints;
    if (!kp || kp.format !== 'coco-wholebody-133' || !Array.isArray(kp.points) || kp.points.length !== 133 ||
      !kp.points.every((p) => Array.isArray(p) && p.length === 3 && p.every(normalized))) return false;
    for (const key of ['headroomHeads', 'shoulderTilt', 'hipTilt', 'shoulderHipAngle']) if (!optional(person, key, finite)) return false;
    if (!optional(person, 'headHeight', (x) => finite(x) && x > 0)) return false;
    if (!optional(person, 'framingTier', (x) => ['chest', 'waist', 'thigh', 'full', 'knee-cut', 'other'].includes(x))) return false;
    if (!optional(person, 'edgeAtJoint', (x) => Array.isArray(x) && x.every((w) => w && edges.includes(w.edge) &&
      joints.includes(w.joint) && finite(w.distanceHeads) && optional(w, 'side', (s) => sides.includes(s))))) return false;
    if (!optional(person, 'handsTruncated', (x) => Array.isArray(x) && x.every((w) => w && sides.includes(w.side) &&
      edges.includes(w.edge)))) return false;
  }
  if (!optional(v, 'focus', (f) => f && optional(f, 'eyeSharpnessNative', normalized) && optional(f, 'afPoint', (p) =>
    Array.isArray(p) && p.length === 2 && p.every(normalized)) && optional(f, 'afPointOnEye', (x) => typeof x === 'boolean') &&
    optional(f, 'afSource', nonEmpty))) return false;
  if (!optional(v, 'faceExposure', (f) => f && optional(f, 'faceClippedHighlights', normalized) && optional(f,
    'faceClippedShadows', normalized))) return false;
  return true;
}
export function validateRuleVerdict(v) {
  return Boolean(v && v.contractVersion === 1 && nonEmpty(v.ruleId) && nonEmpty(v.rulesVersion) && ['pass', 'warn', 'violate',
    'na'].includes(v.verdict) && ['measure', 'teacher'].includes(v.by) && nonEmpty(v.evidence) && optional(v, 'personIndex',
      (i) => Number.isInteger(i) && i >= 0));
}
export function validateCaptureUnit(v) {
  return Boolean(
    v?.contractVersion === 1 &&
      nonEmpty(v.id) &&
      nonEmpty(v.primaryItemId) &&
      Array.isArray(v.itemIds),
  );
}
export function validateUnitResult(v) {
  return Boolean(
    v?.contractVersion === 1 && nonEmpty(v.unitId) && nonEmpty(v.fingerprint) && optional(v, 'signals', validateSignals) &&
      optional(v, 'verdicts', (x) => Array.isArray(x) && x.every(validateRuleVerdict)),
  );
}
export function validateAssetResult(v) {
  return validateUnitResult(v);
}
export function validateGroup(v) {
  return Boolean(
    v?.contractVersion === 1 && nonEmpty(v.id) && Array.isArray(v.unitIds),
  );
}
export function validateDecision(v) {
  return Boolean(
    v?.contractVersion === 1 &&
      nonEmpty(v.unitId || v.id) &&
      ["selected", "candidate", "rejected"].includes(v.action),
  );
}
export function validateAnalysisRun(v) {
  return Boolean(
    v?.contractVersion === 1 &&
      nonEmpty(v.id) &&
      ["queued", "running", "completed", "cancelled", "failed"].includes(
        v.status,
      ),
  );
}
export function contractError(name, value) {
  const validators = {
    CaptureUnit: validateCaptureUnit,
    Signals: validateSignals,
    RuleVerdict: validateRuleVerdict,
    UnitResult: validateUnitResult,
    AssetResult: validateAssetResult,
    Group: validateGroup,
    Decision: validateDecision,
    AnalysisRun: validateAnalysisRun,
  };
  if (!validators[name]?.(value))
    throw new Error(`Invalid ${name} contract v1`);
  return value;
}
