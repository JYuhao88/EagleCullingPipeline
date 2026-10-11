import { bootstrapInterval } from "./preference-head.js";
import { groupConfidence, rankGroup, suggestDecision } from "./ranking.js";
import { buildCandidateSet } from "./candidates.js";
import { decisionsToLabels, evaluateWeights, FIT_KEYS, fitPairwiseWeights, pairwiseSamples, scoreLabels } from "./spot-eval.js";

export const MIN_PERSONALIZE_GROUPS = 0; // Compatibility export; readiness comes from heldout evidence.

function reviewedUnits(decisions) {
  return new Set(decisions.filter(decision => decision.source === "human").map(decision => decision.unitId));
}

function remainingGroups(data, decisions) {
  const reviewed = reviewedUnits(decisions);
  return (data.groups || []).filter(group => group.unitIds.length > 1 &&
    !group.unitIds.some(unitId => reviewed.has(unitId)));
}

export function personalizeReport(data, decisions) {
  const labels = decisionsToLabels(data, decisions);
  const timestamps = new Map(decisions.filter(decision => decision.source === "human")
    .map(decision => [decision.unitId, Date.parse(decision.updatedAt)]));
  const ordered = labels.map(label => ({ ...label, time: timestamps.get(label.bestUnitId) }))
    .filter(label => Number.isFinite(label.time)).sort((a, b) => a.time - b.time);
  const groups = new Map((data.groups || []).map(group => [group.id, group]));
  const results = new Map((data.results || []).map(result => [result.unitId, result]));
  const identities = label => (groups.get(label.groupId)?.unitIds || []).map(id => {
    const item = results.get(id);
    return item?.contentHash || item?.metrics?.sha256 || item?.metrics?.raw?.sha256 || id;
  });
  const splits = [0.6, 0.8].map(fraction => {
    const boundary = Math.floor(ordered.length * fraction);
    const heldout = ordered.slice(boundary);
    const hashes = new Set(heldout.flatMap(identities));
    const train = ordered.slice(0, boundary).filter(label => label.time < (heldout[0]?.time ?? Infinity) &&
      identities(label).every(hash => !hashes.has(hash)));
    const { samples, trainingGroups } = pairwiseSamples(data, train);
    if (!trainingGroups || heldout.length < 2) return { fraction, trainingGroups, sampleCount: heldout.length,
      reason: "insufficient-data", before: null, after: null, improvement: bootstrapInterval([]) };
    const fitted = fitPairwiseWeights(samples);
    const before = scoreLabels(data, heldout); const after = evaluateWeights(data, heldout, fitted);
    const deltas = heldout.map(label => evaluateWeights(data, [label], fitted).top1.rate - scoreLabels(data, [label]).top1.rate);
    return { fraction, trainingGroups, sampleCount: heldout.length, before, after,
      improvement: bootstrapInterval(deltas),
      beforeCI: bootstrapInterval(heldout.map(label => scoreLabels(data, [label]).top1.rate)),
      afterCI: bootstrapInterval(heldout.map(label => evaluateWeights(data, [label], fitted).top1.rate)) };
  });
  const last = splits[1];
  const { samples, trainingGroups } = pairwiseSamples(data, labels);
  const base = { ready: false, labeledGroups: labels.length, neededGroups: null, trainingGroups,
    before: last.before, after: last.after, weights: null,
    remainingGroups: remainingGroups(data, decisions).length,
    method: "temporal-group-content-disjoint-paired-bootstrap", splits,
    improvement: last.improvement, sampleCount: last.sampleCount,
    timestampedGroups: ordered.length, confidenceLevel: 0.95 };
  if (splits.some(split => split.reason)) return { ...base, reason: "insufficient-data" };
  if (splits.some(split => !(split.improvement.lower > 0))) return { ...base, reason: "no-stable-heldout-improvement" };
  const fitted = fitPairwiseWeights(samples);
  return { ...base, ready: true, reason: "validated-improvement",
    weights: { ...Object.fromEntries(FIT_KEYS.map((key, index) => [key, fitted[index]])), aesthetic: 0 } };
}

export function applyPersonalization(data, decisions, report = personalizeReport(data, decisions)) {
  if (!report.ready) return { ...report, changedGroups: 0, data };
  const remaining = new Set(remainingGroups(data, decisions).map(group => group.id));
  const results = new Map((data.results || []).map(result => [result.unitId, result]));
  let changedGroups = 0;
  const groups = (data.groups || []).map(group => {
    if (!remaining.has(group.id) || group.unitIds.some(unitId => !results.has(unitId))) return group;
    const ranking = rankGroup(group.unitIds.map(unitId => results.get(unitId)), report.weights, group);
    const suggestions = ranking.map(entry => [
      entry.unitId, suggestDecision(entry, results.get(entry.unitId), group.unitIds.length),
    ]);
    if (!suggestions.some(([, action]) => action === "selected")) {
      const fallback = suggestions.findIndex(([, action]) => action !== "rejected");
      if (fallback >= 0) suggestions[fallback][1] = "selected";
    }
    const suggested = Object.fromEntries(suggestions);
    const updated = { ...group, ranking, suggested, candidateSet: buildCandidateSet(
      group.unitIds.map(unitId => results.get(unitId))),
    ...groupConfidence({ ...group, ranking }, data.results) };
    if (JSON.stringify(updated) !== JSON.stringify(group)) changedGroups += 1;
    return updated;
  });
  return { ...report, changedGroups, data: { ...data, groups } };
}
