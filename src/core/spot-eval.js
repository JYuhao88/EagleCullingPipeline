import { rankGroup } from "./ranking.js";

export const FIT_KEYS = ["sharpness", "exposure", "eyes", "quality"];

export function decisionsToLabels(resultsData, decisions = []) {
  const stored = Array.isArray(decisions) ? decisions : Object.values(decisions);
  const human = new Map(stored.filter(item => item.source === "human").map(item => [item.unitId, item]));
  return (resultsData.groups || []).flatMap(group => {
    if ((group.unitIds || []).length < 2) return [];
    if (group.unitIds.some(unitId => human.get(unitId)?.tie)) return [];
    const selected = group.unitIds.filter(unitId => human.get(unitId)?.action === "selected");
    return selected.length === 1 ? [{ groupId: group.id, bestUnitId: selected[0] }] : [];
  });
}

export function scoreLabels(resultsData, labels) {
  const groups = new Map((resultsData.groups || [])
    .filter((group) => group.unitIds.length >= 2).map((group) => [group.id, group]));
  let topHits = 0;
  let topTotal = 0;
  let pairWins = 0;
  let pairTotal = 0;
  let unable = 0;
  for (const label of labels) {
    if (label.bestUnitId == null) {
      unable += 1;
      continue;
    }
    const group = groups.get(label.groupId);
    if (!group) continue;
    const ranking = group.ranking || [];
    const modelBest = ranking.find((entry) => entry.rank === 1)?.unitId;
    topTotal += 1;
    if (modelBest === label.bestUnitId) topHits += 1;
    const bestScore = ranking.find((entry) => entry.unitId === label.bestUnitId)?.score;
    if (!Number.isFinite(bestScore)) continue;
    for (const unitId of group.unitIds) {
      if (unitId === label.bestUnitId) continue;
      const otherScore = ranking.find((entry) => entry.unitId === unitId)?.score;
      if (!Number.isFinite(otherScore)) continue;
      pairTotal += 1;
      if (bestScore > otherScore) pairWins += 1;
    }
  }
  return {
    runId: resultsData.run?.id || null,
    top1: { hits: topHits, total: topTotal, rate: topTotal ? topHits / topTotal : null },
    unable,
    pairwise: { wins: pairWins, total: pairTotal, rate: pairTotal ? pairWins / pairTotal : null },
  };
}

function metricValue(item, key) {
  const metrics = item?.metrics || {};
  if (key === "eyes") {
    if (!Number.isFinite(metrics.faces) || metrics.faces <= 0 || !Number.isFinite(metrics.eyesClosed))
      return null;
    return 1 - Math.min(1, metrics.eyesClosed / metrics.faces);
  }
  const value = metrics[key] ?? item?.[key];
  return Number.isFinite(value) ? value : null;
}

export function pairwiseSamples(resultsData, labels) {
  const results = new Map((resultsData.results || []).map((item) => [item.unitId, item]));
  const groups = new Map((resultsData.groups || []).map((group) => [group.id, group]));
  const samples = [];
  let trainingGroups = 0;
  for (const label of labels) {
    if (label.bestUnitId == null) continue;
    const group = groups.get(label.groupId);
    if (!group || !group.unitIds.includes(label.bestUnitId)) continue;
    const chosen = results.get(label.bestUnitId);
    const chosenValues = Object.fromEntries(FIT_KEYS.map((key) => [key, metricValue(chosen, key)]));
    const others = group.unitIds.filter((unitId) => unitId !== label.bestUnitId);
    let added = 0;
    for (const unitId of others) {
      const otherValues = Object.fromEntries(FIT_KEYS.map((key) => [key, metricValue(results.get(unitId), key)]));
      if (FIT_KEYS.some((key) => !Number.isFinite(chosenValues[key]) || !Number.isFinite(otherValues[key]))) continue;
      samples.push({
        features: FIT_KEYS.map((key) => chosenValues[key] - otherValues[key]),
        chosenUnitId: label.bestUnitId,
        otherUnitId: unitId,
        groupId: group.id,
      });
      added += 1;
    }
    if (added) trainingGroups += 1;
  }
  return { samples, trainingGroups };
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function fitPairwiseWeights(samples, { l2 = 1, iterations = 4000, learningRate = 0.08 } = {}) {
  const weights = [0, 0, 0, 0];
  for (let step = 0; step < iterations; step += 1) {
    const gradient = weights.map((weight) => l2 * weight);
    for (const sample of samples) {
      const probability = sigmoid(sample.features.reduce((sum, value, index) => sum + value * weights[index], 0));
      sample.features.forEach((value, index) => { gradient[index] += (probability - 1) * value; });
    }
    gradient.forEach((value, index) => { weights[index] -= learningRate * value / Math.max(1, samples.length); });
    weights.forEach((value, index) => { weights[index] = Math.max(0, value); });
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  return total ? weights.map((value) => value / total) : weights.map(() => 0.25);
}

export function evaluateWeights(resultsData, labels, weights) {
  // Heldout evaluation only reads labeled groups. Re-ranking every unrelated
  // group for each bootstrap input blocks live review on large cached runs.
  const labeled = new Set(labels.map(label => label.groupId));
  const groups = new Map((resultsData.groups || []).map((group) => [group.id, group]));
  const results = new Map((resultsData.results || []).map((item) => [item.unitId, item]));
  const rankingData = { ...resultsData, groups: [...groups.values()].filter(group => labeled.has(group.id)).map((group) => ({
    ...group,
    ranking: rankGroup(group.unitIds.map((unitId) => results.get(unitId)).filter(Boolean),
      { ...Object.fromEntries(FIT_KEYS.map((key, index) => [key, weights[index]])), aesthetic: 0 })
      .map(({ unitId, rank, score }) => ({ unitId, rank, score })),
  })) };
  return scoreLabels(rankingData, labels);
}
