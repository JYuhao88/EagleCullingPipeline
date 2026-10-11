import { assessClosedEyes } from "./eye-assessment.js";
import { evaluateRules } from "./rules-engine.js";
import { createRequire } from "node:module";

const eyeAssessments = new WeakMap();
const rankingConfig = createRequire(import.meta.url)("./ranking-weights.json");

const labels = {
  "possibly-blurry": "可能模糊",
  blurry: "可能模糊",
  "eyes-closed": "闭眼",
  noisy: "严重噪点",
  overexposed: "过曝",
  underexposed: "欠曝",
  "low-resolution": "低分辨率",
};
export const RANKING_WEIGHTS = Object.freeze({ ...rankingConfig.weights });
export const RANKING_WEIGHTS_META = Object.freeze({
  version: rankingConfig.version,
  source: rankingConfig.source,
});
// A score gap below 0.03 needs confirmation, as does any serious issue on the first choice.
export const CONFIDENCE_MARGIN_THRESHOLD = 0.03;
export const SERIOUS_RANKING_FLAGS = Object.freeze(["blurry", "eyes-closed", "overexposed", "underexposed", "noisy"]);
const GATE_REASON = "硬伤门槛：排在通过者之后";

export function groupConfidence(group, results = []) {
  const ranking = [...(group.ranking || [])].sort((left, right) => left.rank - right.rank);
  const size = group.unitIds?.length ?? ranking.length;
  if (size <= 1) return { confidence: "single", margin: null };
  const [first, second] = ranking;
  const crossGate = Boolean(first?.reasons?.includes(GATE_REASON)) !== Boolean(second?.reasons?.includes(GATE_REASON));
  const margin = !crossGate && Number.isFinite(first?.score) && Number.isFinite(second?.score)
    ? Number((first.score - second.score).toFixed(4)) : null;
  const byId = results instanceof Map ? results : new Map(results.map(result => [result.unitId || result.id, result]));
  const item = byId.get(first?.unitId);
  const flags = [...(first?.flags || []), ...gateFlags(item || {})];
  const serious = flags.some(flag => SERIOUS_RANKING_FLAGS.includes(flag));
  const confidence = margin !== null && margin >= CONFIDENCE_MARGIN_THRESHOLD && !serious ? "high" : "low";
  return { confidence, margin };
}
const metricValue = (item, key) => {
  const metrics = item.metrics || {};
  if (key === "eyes") {
    if (!Number.isFinite(metrics.faces) || metrics.faces <= 0) return null;
    if (!Number.isFinite(metrics.eyesClosed)) return null;
    if (eyeAssessments.get(item)?.assessed) return eyeAssessments.get(item).closed ? 0 : 1;
    return 1 - Math.min(1, metrics.eyesClosed / metrics.faces);
  }
  const value = key === "exposure"
    ? (metrics.exposureSuitability ?? metrics.exposure ?? item.exposure)
    : metrics[key] ?? item[key];
  return Number.isFinite(value) ? value : null;
};
function proxyFaceHighlight(item) {
  if (item.signals?.imageMeasurements?.version !== "measure-v3") return null;
  const values = (item.signals.persons || []).filter((p) => p.isMain && p.faceExposurePixels >= 64 &&
    Number.isFinite(p.faceClippedHighlights) && p.faceClippedHighlights >= 0 && p.faceClippedHighlights <= 1)
    .map((p) => p.faceClippedHighlights);
  return values.length ? Math.max(...values) : null;
}
export function gateFlags(item) {
  const c = rankingConfig.gates;
  const flags = item.flags || item.qualityFlags || [];
  const metrics = item.metrics || {};
  const result = new Set(flags);
  const face = metrics.raw?.faceExposure;
  const sky = metrics.raw?.skyExposure;
  if (sky?.version === 'sky-v1') result.delete('overexposed');
  const sceneHighlights = sky?.version === 'sky-v1' && Number.isFinite(sky.subject?.clippedHigh)
    ? sky.subject.clippedHigh : metrics.clippedHighlights;
  if (Number.isFinite(metrics.sharpness) && metrics.sharpness < c.sharpnessBelow) result.add("blurry");
  const detail = metrics.raw?.technicalDetail;
  // Missing detail/model measurements abstain; never fabricate quality.
  if (detail?.version === "detail-512-v1" && Number.isFinite(metrics.quality)) {
    if (detail.laplacianVariance < c.detailVarianceBelow && metrics.quality < c.detailQualityBelow) result.add("blurry");
    if (detail.noiseSigma > c.noiseSigmaAbove && metrics.quality < c.noiseQualityBelow) result.add("noisy");
  }
  const sceneOnly = !face && !Number.isFinite(metrics.faceClippedHighlights) &&
    !Number.isFinite(metrics.faceClippedShadows);
  if (sceneOnly && Number.isFinite(metrics.raw?.meanLuma) && metrics.raw.meanLuma < c.darkMean &&
      Number.isFinite(metrics.raw?.lumaVariance) && metrics.raw.lumaVariance < c.darkVarianceBelow &&
      metrics.clippedShadows >= c.darkShadowFraction) result.add("underexposed");
  if (sceneOnly && sceneHighlights >= c.highlightFraction) result.add("overexposed");
  // The bench/current signals can contain matched inner-face pixel measurements
  // even when normalized metrics has no face ROI. Use pixels, never verdicts.
  if (!face && !Number.isFinite(metrics.faceClippedHighlights) &&
      proxyFaceHighlight(item) !== null && proxyFaceHighlight(item) >= c.faceHighlightFraction) result.add("overexposed");
  const eyes = eyeAssessments.get(item) || assessClosedEyes(item);
  result.delete("eyes-closed");
  if (eyes.gate) result.add("eyes-closed");
  if ((metrics.faceClippedHighlights ?? face?.clippedHigh ?? sceneHighlights) >=
      (face || Number.isFinite(metrics.faceClippedHighlights) ? c.faceHighlightFraction : c.highlightFraction))
    result.add("overexposed");
  if ((metrics.faceClippedShadows ?? face?.clippedLow ?? metrics.clippedShadows) >=
      (face || Number.isFinite(metrics.faceClippedShadows) ? c.faceShadowFraction : c.shadowFraction) ||
      (Number.isFinite(face?.meanLuma) && face.meanLuma < c.faceDarkMean))
    result.add("underexposed");
  return [...result];
}
const penaltyCategory = (id) => {
  if (/^P-CROP-(NECK|WRIST|ELBOW|KNEE|ANKLE-FOOT)$/.test(id)) return "jointCrop";
  if (id === "P-CROP-HAIRLINE") return "headCrop";
  if (id === "P-EXPOSURE-INTENT") return "faceHighlight";
  if (["L-HORIZON-LEVEL", "L-VERTICAL-LEVEL", "S-TILT-INTENT"].includes(id)) return "severeTilt";
  return undefined;
};
export function rulePenalty(item) {
  // One charge per joint rule; duplicate people and equivalent tilt genre rules share a charge.
  const categories = new Set((item.verdicts || []).filter((v) => v.by === "measure" && v.verdict === "violate")
    .map((v) => {
      const category = penaltyCategory(v.ruleId);
      return category === "jointCrop" ? `${category}:${v.ruleId}` : category;
    }).filter(Boolean));
  return [...categories].reduce((sum, key) => sum + (rankingConfig.rulePenalties[key.split(":")[0]] || 0), 0);
}
export function rankGroup(items, weights = RANKING_WEIGHTS, { averageSimilarity } = {}) {
  const multiple = items.length > 1;
  // Relative hints are evaluated only after the existing grouping has finished.
  const groupSignals = items.map((item) => item.signals).filter(Boolean);
  for (const item of items) {
    eyeAssessments.set(item, assessClosedEyes(item, items));
    if (item.signals) item.verdicts = evaluateRules(item.signals, { faces: item.faces, groupSignals, groupUnits: items });
  }
  const keys = Object.keys(weights).filter((key) => weights[key] > 0 &&
    items.every((item) => metricValue(item, key) !== null),
  );
  const totalWeight = keys.reduce((sum, key) => sum + weights[key], 0);
  const scores = items
    .map((item) => {
      const values = keys.map((key) => [key, metricValue(item, key)]);
      return {
        item,
        score: totalWeight
          ? values.reduce((sum, [key, value]) => sum + value * weights[key], 0) /
            totalWeight - (multiple ? rulePenalty(item) : 0)
          : -(multiple ? rulePenalty(item) : 0),
        eyeDeferred: eyeAssessments.get(item)?.subjects?.some(s => s.closed && s.openElsewhere && !s.gate) || false,
        gated: gateFlags(item).some((flag) => SERIOUS_RANKING_FLAGS.includes(flag)),
      };
    })
    .sort(
      (a, b) =>
        Number(a.gated) - Number(b.gated) ||
        Number(a.eyeDeferred) - Number(b.eyeDeferred) ||
        b.score - a.score ||
        String(a.item.unitId || a.item.id).localeCompare(
          String(b.item.unitId || b.item.id),
        ),
    );
  const margin = multiple
    ? Number((Number(scores[0].score.toFixed(4)) - Number(scores[1].score.toFixed(4))).toFixed(4)) : null;
  const close = multiple && scores[0].gated === scores[1].gated && margin >= 0 && margin < CONFIDENCE_MARGIN_THRESHOLD;
  return scores.map(({ item, score }, index) => {
    const flags = gateFlags(item);
    const bestItem = scores[0]?.item;
    const bestValues = Object.fromEntries(
      keys.map((key) => [key, metricValue(bestItem, key)]),
    );
    const reasons = [];
    for (const verdict of item.verdicts || []) if (["violate", "warn", "hint"].includes(verdict.verdict)) {
      const charged = multiple && verdict.by === "measure" && verdict.verdict === "violate" &&
        rankingConfig.rulePenalties[penaltyCategory(verdict.ruleId)] > 0;
      reasons.push(`${charged ? "规则扣分" : "规则提示"} ${verdict.ruleId}：${verdict.evidence}`);
    }
    if (flags.includes("noisy")) reasons.push("严重噪点");
    const blurry =
      flags.includes("blurry") || flags.includes("possibly-blurry");
    const over = flags.includes("overexposed");
    const under = flags.includes("underexposed");
    const closed = flags.includes("eyes-closed");
    if (flags.some((flag) => SERIOUS_RANKING_FLAGS.includes(flag))) {
      reasons.push(GATE_REASON);
    }
    if (multiple) {
      if (index === 0) {
        const leaders = keys
          .map((key) => ({
            key,
            margin: metricValue(item, key) -
              Math.max(...scores.slice(1).map((other) => metricValue(other.item, key))),
          }))
          .filter(({ margin }) => margin > 0.02)
          .sort((a, b) => b.margin - a.margin)
          .slice(0, 2)
          .map(({ key }) => ({
            sharpness: "清晰度组内最高",
            quality: "质量分组内最高",
            exposure: "曝光组内最高",
            eyes: "睁眼率组内最高",
          })[key])
          .filter(Boolean);
        if (!flags.some((flag) => SERIOUS_RANKING_FLAGS.includes(flag))) {
          reasons.push(scores.some(other => other.eyeDeferred && other.score > score) ? "同组睁眼帧优先" :
            scores.some(other => other.gated) ? "通过门槛者中综合分最高" : "综合分最高", ...leaders);
        }
        if (close) reasons.push("与第二名很接近，建议人工确认");
        if (blurry) reasons.push("整体偏模糊");
      } else {
        const differences = keys
          .map((key) => ({
            key,
            difference: (bestValues[key] ?? 0) - (metricValue(item, key) ?? 0),
          }))
          .filter(({ difference }) => difference > 0.05)
          .sort((a, b) => b.difference - a.difference)
          .slice(0, 2);
        for (const { key } of differences) {
          const labelsByKey = {
            sharpness: "比首选更模糊",
            quality: "质量分低于首选",
            exposure: "曝光不如首选",
            eyes: "睁眼率低于首选",
          };
          if (labelsByKey[key]) reasons.push(labelsByKey[key]);
        }
        if (Number.isFinite(averageSimilarity) && averageSimilarity >= 0.9)
          reasons.push("与首选高度相似");
      }
    } else if (!blurry) {
      reasons.push("清晰");
    } else {
      reasons.push("模糊");
    }
    if (over) reasons.push(item.metrics?.raw?.faceExposure || proxyFaceHighlight(item) >= rankingConfig.gates.faceHighlightFraction
      ? "面部高光严重溢出" : "过曝");
    else if (under) reasons.push(item.metrics?.raw?.faceExposure ? "面部严重欠曝或死黑" : "欠曝");
    else if ((item.metrics?.exposure ?? 0) >= 0.7 && !reasons.includes("曝光不如首选")) {
      reasons.push("曝光正常");
    }
    if (closed) reasons.push("闭眼");
    else if (eyeAssessments.get(item)?.warn) reasons.push(`闭眼待复核：${eyeAssessments.get(item).evidence}`);
    if (item.metrics?.raw?.skyExposure?.skyClippedFraction >= rankingConfig.sky.hintClippedFraction)
      reasons.push("提示：天空过曝无细节");
    return {
      unitId: item.unitId || item.id,
      rank: index + 1,
      score: Number(score.toFixed(4)),
      reasons: [...new Set(reasons.length ? reasons : ["综合质量较高"])],
    };
  });
}
export function suggestDecision(entry, result, groupSize = 1) {
  const flags = gateFlags(result);
  const serious = flags.some((flag) => SERIOUS_RANKING_FLAGS.includes(flag));
  if (entry.rank === 1 && !serious) return "selected";
  if (entry.rank > 1 && groupSize > 1 && serious) return "rejected";
  if (groupSize === 1 && serious) return "rejected";
  if (entry.rank === 1 && groupSize > 1) return "candidate";
  if (serious) return "rejected";
  return "candidate";
}
