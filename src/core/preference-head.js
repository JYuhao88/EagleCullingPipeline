// L1 is a small signed Bradley–Terry head. It never invokes a visual model.
export const PREFERENCE_VERSION = "l1-bt-v1";
export const EMBEDDING_DIMENSIONS = 12;
export const GENRE_KEYS = Object.freeze(["portrait", "street", "landscape", "general"]);
export const SIGNAL_WEIGHTS = Object.freeze({ corrected: 3, explicit: 1, bulk: 0.1, tombstone: 3 });
export const FEATURE_KEYS = Object.freeze([
  "sharpness", "exposure", "quality", "aesthetic", "eyes", "brightness",
  "clippedHighlights", "clippedShadows", "focus", "faceArea", "cropTightness",
]);

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function dot(a, b) { return a.reduce((sum, value, index) => sum + value * b[index], 0); }
function time(value) { const number = typeof value === "number" ? value : Date.parse(value); return finite(number) ? number : 0; }
function sigmoid(value) { return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value)))); }
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

function metricValues(feature) {
  const metrics = feature?.metrics || {};
  const faces = feature?.faces || feature?.faceSummary || {};
  const faceCount = metrics.faces ?? faces.count;
  const closed = metrics.eyesClosed ?? faces.eyesClosed;
  const boxes = (Array.isArray(faces) ? faces : faces.items || []).map(face => face.box).filter(Array.isArray);
  const areas = boxes.map(box => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]));
  const area = areas.length ? Math.max(...areas) : faces.largestArea;
  const people = feature?.signals?.people || feature?.signals?.persons || [];
  const personBox = people.find(person => person.isMain)?.box || people[0]?.box;
  const bodyArea = Array.isArray(personBox) && personBox.every(finite)
    ? Math.max(0, personBox[2] - personBox[0]) * Math.max(0, personBox[3] - personBox[1]) : null;
  const raw = metrics.raw || {};
  return {
    ...metrics,
    eyes: finite(faceCount) && faceCount > 0 && finite(closed) ? 1 - closed / faceCount : metrics.eyes,
    brightness: finite(raw.meanLuma ?? metrics.meanLuma) ? (raw.meanLuma ?? metrics.meanLuma) / 255 : metrics.brightness,
    focus: finite(metrics.focus) ? metrics.focus : metrics.focus?.score ?? metrics.focus?.subjectSharpness ?? feature?.focus?.score,
    faceArea: metrics.faceArea ?? area,
    cropTightness: metrics.cropTightness ?? feature?.groupContext?.cropTightness ?? bodyArea ?? area,
  };
}

// A fixed signed projection avoids fitting PCA on holdout images. No fitted scaler
// or projection can leak information from the evaluation period into training.
export function preferenceVector(feature) {
  const values = metricValues(feature);
  const vector = FEATURE_KEYS.map(key => finite(values[key]) ? Math.max(-2, Math.min(2, values[key])) : 0);
  const masks = FEATURE_KEYS.map(key => finite(values[key]) ? 0 : 1);
  const embedding = Array.isArray(feature?.embedding) ? feature.embedding : feature?.embedding?.vector;
  const reduced = Array(EMBEDDING_DIMENSIONS).fill(0);
  if (Array.isArray(embedding) && embedding.length && embedding.every(finite)) {
    const norm = Math.sqrt(dot(embedding, embedding)) || 1;
    embedding.forEach((value, index) => {
      // Multiplicative integer hash yields repeatable balanced buckets/signs.
      const hash = Math.imul(index + 1, 0x9e3779b1) >>> 0;
      reduced[hash % EMBEDDING_DIMENSIONS] += (hash & 0x80000000 ? -1 : 1) * value / norm;
    });
  }
  const probabilities = feature?.genreProbabilities || {};
  const knownGenre = GENRE_KEYS.includes(feature?.genre);
  const genreValues = GENRE_KEYS.map(genre => finite(probabilities[genre])
    ? Math.max(0, Math.min(1, probabilities[genre])) : knownGenre ? Number(feature.genre === genre) : 0);
  const interactions = genreValues.flatMap(probability => vector.map(value => value * probability));
  const genreMasks = GENRE_KEYS.map(genre => finite(probabilities[genre]) || knownGenre ? 0 : 1);
  return [...vector, ...masks, ...reduced, Array.isArray(embedding) && embedding.length && embedding.every(finite) ? 0 : 1,
    ...interactions, ...genreMasks];
}

export function preferenceScore(feature, head) {
  if (head?.version !== PREFERENCE_VERSION || !Array.isArray(head.weights)) return null;
  const vector = preferenceVector(feature);
  return head.weights.length === vector.length ? dot(vector, head.weights) : null;
}

function usableGroups(groups) {
  // Revisions of a reviewed group are one observation, never repeated samples.
  const latest = new Map();
  for (const group of groups) {
    if (!Array.isArray(group.candidates) || group.candidates.length < 2) continue;
    const key = `${group.profileId || "default"}:${group.runId || ""}:${group.id}`;
    if (!latest.has(key) || time(group.time) >= time(latest.get(key).time)) latest.set(key, group);
  }
  return [...latest.values()].filter(group => (group.winners || []).length || (group.rejectedHashes || []).length)
    .sort((a, b) => time(a.time) - time(b.time) || String(a.id).localeCompare(String(b.id)));
}

export function preferenceSamples(groups, { halfLifeDays = 90, now = null } = {}) {
  const ordered = usableGroups(groups);
  const reference = now == null ? Math.max(0, ...ordered.map(group => time(group.time))) : time(now);
  const samples = [];
  for (const group of ordered) {
    const selected = new Set(group.winners || []);
    const rejected = new Set(group.rejectedHashes || []);
    const pairs = [];
    for (let i = 0; i < group.candidates.length; i += 1) {
      for (let j = i + 1; j < group.candidates.length; j += 1) {
        const a = group.candidates[i]; const b = group.candidates[j];
        let target;
        if (selected.has(a.hash) && selected.has(b.hash) && group.tie) target = 0.5;
        else if (selected.has(a.hash) !== selected.has(b.hash)) target = selected.has(a.hash) ? 1 : 0;
        else if (rejected.has(a.hash) !== rejected.has(b.hash)) target = rejected.has(a.hash) ? 0 : 1;
        else continue; // All-rejected groups do not invent a winner.
        const av = preferenceVector(a.feature); const bv = preferenceVector(b.feature);
        pairs.push({ features: av.map((value, index) => value - bv[index]), target, groupId: group.id,
          groupKey: `${group.runId || ""}:${group.id}` });
      }
    }
    const age = Math.max(0, reference - time(group.time)) / 86_400_000;
    const decay = finite(halfLifeDays) && halfLifeDays > 0 ? 2 ** (-age / halfLifeDays) : 1;
    const weight = (SIGNAL_WEIGHTS[group.signal] ?? SIGNAL_WEIGHTS.explicit) * decay;
    // A large burst must not outweigh dozens of explicit decisions.
    for (const pair of pairs) samples.push({ ...pair, weight: weight / pairs.length });
  }
  return samples;
}

export function fitPreferenceHead(groups, options = {}) {
  const samples = preferenceSamples(groups, options);
  const weights = preferenceVector({}).map(() => 0);
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const { iterations = 450, learningRate = 0.35, l2 = 0.015 } = options;
  for (let step = 0; step < iterations && totalWeight > 0; step += 1) {
    const gradient = weights.map(weight => l2 * weight);
    for (const sample of samples) {
      const error = (sigmoid(dot(sample.features, weights)) - sample.target) * sample.weight / totalWeight;
      sample.features.forEach((value, index) => { gradient[index] += error * value; });
    }
    gradient.forEach((value, index) => { weights[index] -= learningRate * value; });
  }
  return { version: PREFERENCE_VERSION, projectionVersion: "signed-hash-12-genre4-v1", weights,
    trainingGroups: new Set(samples.map(sample => sample.groupKey)).size, sampleCount: samples.length,
    effectiveWeight: totalWeight, halfLifeDays: options.halfLifeDays ?? 90 };
}

export function temporalSplit(groups, fraction = 0.7) {
  const ordered = usableGroups(groups);
  const boundary = Math.floor(ordered.length * fraction);
  const test = ordered.slice(boundary);
  // Same content in another run must never cross the split.
  const testHashes = new Set(test.flatMap(group => group.candidates.map(candidate => candidate.hash)));
  const testIds = new Set(test.map(group => group.id));
  const cutoff = test.length ? time(test[0].time) : Infinity;
  const train = ordered.slice(0, boundary).filter(group => time(group.time) < cutoff && !testIds.has(group.id) &&
    group.candidates.every(candidate => !testHashes.has(candidate.hash)));
  return { train, test, purgedGroups: boundary - train.length, cutoff };
}

function orderedCandidates(group, head) {
  return [...group.candidates].sort((a, b) => {
    if (head && (a.tier ?? 0) !== (b.tier ?? 0)) return (a.tier ?? 0) - (b.tier ?? 0);
    if (!head && finite(a.baselineRank) && finite(b.baselineRank)) return a.baselineRank - b.baselineRank;
    const as = head ? preferenceScore(a.feature, head) : a.baselineScore;
    const bs = head ? preferenceScore(b.feature, head) : b.baselineScore;
    return (finite(bs) ? bs : -Infinity) - (finite(as) ? as : -Infinity) || String(a.hash).localeCompare(String(b.hash));
  });
}
function topHash(group, head) { return orderedCandidates(group, head)[0]?.hash; }

function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function bootstrapInterval(values, { repetitions = 500, seed = 719 } = {}) {
  if (!values.length) return { estimate: null, lower: null, upper: null, n: 0 };
  const random = rng(seed);
  const estimates = [];
  for (let i = 0; i < repetitions; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)];
    estimates.push(sum / values.length);
  }
  estimates.sort((a, b) => a - b);
  return { estimate: average(values), lower: estimates[Math.floor(repetitions * 0.025)],
    upper: estimates[Math.min(repetitions - 1, Math.floor(repetitions * 0.975))], n: values.length };
}

export function scorePreferenceHead(groups, head, options = {}) {
  const before = []; const after = [];
  const pairBefore = [], pairAfter = [], ndcgBefore = [], ndcgAfter = [];
  let pairCount = 0, tieGroups = 0;
  for (const group of groups) {
    // Weak acceptance is never evidence that personal preferences beat L0.
    if (group.signal === "bulk" || !(group.winners || []).length ||
      !group.candidates.every(candidate => finite(candidate.baselineScore) || finite(candidate.baselineRank))) continue;
    before.push(group.winners.includes(topHash(group, null)) ? 1 : 0);
    after.push(group.winners.includes(topHash(group, head)) ? 1 : 0);
    const selected = new Set(group.winners);
    const measure = model => {
      const ranking = orderedCandidates(group, model);
      const ranks = new Map(ranking.map((candidate, index) => [candidate.hash, index]));
      let wins = 0, pairs = 0;
      for (const chosen of selected) for (const other of group.candidates) {
        if (selected.has(other.hash)) continue;
        pairs++; if (ranks.get(chosen) < ranks.get(other.hash)) wins++;
      }
      const k = Math.min(5, ranking.length);
      const dcg = ranking.slice(0, k).reduce((sum, candidate, index) =>
        sum + (selected.has(candidate.hash) ? 1 / Math.log2(index + 2) : 0), 0);
      const ideal = Array.from({ length: Math.min(k, selected.size) }, (_, index) => 1 / Math.log2(index + 2))
        .reduce((sum, value) => sum + value, 0);
      return { pairwise: pairs ? wins / pairs : null, pairs, ndcg: ideal ? dcg / ideal : null };
    };
    const base = measure(null), personalized = measure(head);
    if (base.pairs) { pairBefore.push(base.pairwise); pairAfter.push(personalized.pairwise); pairCount += base.pairs; }
    ndcgBefore.push(base.ndcg); ndcgAfter.push(personalized.ndcg);
    if (group.tie) tieGroups++;

  }
  return { sampleCount: before.length, before: bootstrapInterval(before, options), after: bootstrapInterval(after, options),
    improvement: bootstrapInterval(after.map((value, index) => value - before[index]), options),
    pairCount, tieGroups, tieRate: before.length ? tieGroups / before.length : null,
    metrics: { before: { pairwise: bootstrapInterval(pairBefore, options), ndcgAt5: bootstrapInterval(ndcgBefore, options) },
      after: { pairwise: bootstrapInterval(pairAfter, options), ndcgAt5: bootstrapInterval(ndcgAfter, options) } } };
}

export function evaluatePreferenceHead(groups, options = {}) {
  const splits = [0.6, 0.8].map(fraction => {
    const split = temporalSplit(groups, fraction);
    const head = fitPreferenceHead(split.train, options);
    return { fraction, trainingGroups: head.trainingGroups, purgedGroups: split.purgedGroups,
      cutoff: split.cutoff, ...scorePreferenceHead(split.test, head, options) };
  });
  const enough = splits.every(split => split.trainingGroups > 0 && split.sampleCount > 1);
  const ready = enough && splits.every(split => split.improvement.lower > 0);
  return { ready, reason: !enough ? "insufficient-data" : ready ? "validated-improvement" : "no-stable-heldout-improvement",
    method: "temporal-group-and-content-disjoint-paired-bootstrap", confidenceLevel: 0.95, splits,
    before: splits[1].before, after: splits[1].after, improvement: splits[1].improvement,
    sampleCount: splits[1].sampleCount, pairCount: splits[1].pairCount, metrics: splits[1].metrics,
    tieRate: splits[1].tieRate, labeledGroups: usableGroups(groups).length };
}

export function learningCurve(groups, options = {}) {
  const split = temporalSplit(groups, options.fraction ?? 0.7);
  return [10, 25, 50, 100, 200].map(count => {
    if (split.train.length < count) return { groups: count, availableGroups: split.train.length,
      reason: "insufficient-data", sampleCount: 0 };
    const head = fitPreferenceHead(split.train.slice(0, count), options);
    return { groups: count, trainingGroups: head.trainingGroups, ...scorePreferenceHead(split.test, head, options) };
  });
}

export function driftReport(groups, head, { recentGroups = 25, threshold = 0.2 } = {}) {
  const eligible = usableGroups(groups).filter(group => group.signal !== "bulk" && group.winners?.length);
  const recent = eligible.slice(-recentGroups);
  const preceding = eligible.slice(-recentGroups * 2, -recentGroups);
  const accuracy = set => set.map(group => group.winners.includes(topHash(group, head)) ? 1 : 0);
  const current = bootstrapInterval(accuracy(recent)); const previous = bootstrapInterval(accuracy(preceding));
  const enough = recent.length === recentGroups && preceding.length === recentGroups;
  const drop = enough ? previous.estimate - current.estimate : null;
  // Test the window difference directly. Disjoint marginal 95% intervals test
  // a stricter, different hypothesis and miss meaningful declines at N=25.
  const random = rng(719), differences = [];
  const before = accuracy(preceding), after = accuracy(recent);
  if (enough) for (let b = 0; b < 2000; b++) {
    let sum = 0;
    for (let i = 0; i < recentGroups; i++) {
      sum += before[Math.floor(random() * recentGroups)] - after[Math.floor(random() * recentGroups)];
    }
    differences.push(sum / recentGroups);
  }
  differences.sort((a, b) => a - b);
  const lower = enough ? differences[Math.floor(differences.length * 0.05)] : null;
  return { detected: enough && drop >= threshold && lower > 0,
    method: "independent-window-bootstrap-difference-one-sided-95", minimumDrop: threshold,
    difference: { estimate: drop, lower, confidenceLevel: 0.95, repetitions: 2000 },
    reason: enough ? "recent-top1-agreement" : "insufficient-data", recentGroups, previous, current, drop,
    uncertaintyOnly: true };
}

// Events are immutable full-group snapshots. Exposure-only records and undo
// targets are excluded; a restored decision snapshot may itself be trained.
export function eventsToPreferenceGroups(events, features) {
  const getFeature = hash => features instanceof Map ? features.get(hash) : features?.[hash];
  const undone = new Set(events.filter(event => event.type === "undo").map(event => event.targetEventId));
  const groups = [];
  const prior = new Map();
  const negatives = new Map();
  // 留存 photos were kept as a record, not judged: from the decision that marks them on they drop out of their group.
  const recorded = new Map();
  for (const event of [...events].sort((a, b) => time(a.timestamp) - time(b.timestamp))) {
    if (undone.has(event.id) || !["decision", "tombstone", "undo", "exposure"].includes(event.type)) continue;
    const key = `${event.profileId || "default"}:${event.runId || ""}:${event.groupId}`;
    const previous = prior.get(key);
    if (["decision", "undo"].includes(event.type)) recorded.set(key, new Set((event.decisions || [])
      .filter(decision => decision.action === "record" && decision.hash).map(decision => decision.hash)));
    const skip = recorded.get(key) || new Set();
    const hashes = (event.candidateHashes || previous?.candidates.map(candidate => candidate.hash))?.filter(hash => !skip.has(hash));
    if (!Array.isArray(hashes)) continue;
    const ranking = event.ai?.ranking || [];
    const candidates = hashes.map(hash => {
      const entry = ranking.find(row => row.hash === hash);
      const old = previous?.candidates.find(candidate => candidate.hash === hash);
      const reasons = entry?.reasons || [];
      return { hash, feature: getFeature(hash), baselineScore: entry?.l0Score ?? entry?.score ?? old?.baselineScore,
        baselineRank: entry?.l0Rank ?? entry?.rank ?? old?.baselineRank,
        tier: entry ? (reasons.includes("硬伤门槛：排在通过者之后") ? 2 : 0)
          + (reasons.includes("同组睁眼帧优先") ? -1 : 0) : old?.tier ?? 0 };
    }).filter(candidate => candidate.feature);
    if (candidates.length !== hashes.length) continue;
    const decisions = event.decisions || [];
    const rejected = negatives.get(key) || new Set();
    if (event.type === "tombstone") rejected.add(event.hash);
    negatives.set(key, rejected);
    const chosen = ["tombstone", "exposure"].includes(event.type) ? previous?.winners || []
      : event.winners || decisions.filter(decision => decision.action === "selected").map(decision => decision.hash);
    const winners = chosen.filter(hash => !rejected.has(hash));
    const group = { id: event.groupId, runId: event.runId, profileId: event.profileId || "default", time: event.timestamp,
      candidates, winners, tie: event.type === "exposure" ? previous?.tie : event.tie || decisions.some(decision => decision.tie),
      signal: event.type === "tombstone" ? "tombstone" : event.signal,
      rejectedHashes: [...rejected], eventId: event.id };
    prior.set(key, group);
    if (event.type !== "exposure") groups.push(group);
  }
  return usableGroups(groups);
}
