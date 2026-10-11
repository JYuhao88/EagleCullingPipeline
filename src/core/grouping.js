/**
 * Similarity grouping combines perceptual hashes with the optional DINOv2
 * embedding and small temporal/sequence bonuses.  GROUPING_DEFAULTS is the
 * only tuning surface; values were selected against test/fixtures/fixture-groups.json,
 * the sole labelled set currently available, so overfitting remains possible.
 */
import { hammingDistance } from "./metrics.js";
import { enrichCaptureMetadata, assignCaptureSessions } from "./capture-metadata.js";

/** Backward-compatible late enrichment for callers that bypass the scanner. */
export async function readCaptureTimes(records, { signal } = {}) {
  await enrichCaptureMetadata(records.filter(record => !record.captureTime && !record.exif), { signal });
  assignCaptureSessions(records);
  return new Map(records.filter(record => record.captureTime).map(record => [record.filePath, record.captureTime]));
}

export const GROUPING_DEFAULTS = {
  phashDistance: 10,
  dhashDistance: 10,
  embeddingSimilarity: 0.78,
  timeWindowSeconds: 3,
  sequenceWindow: 4,
  temporalBonus: 0.08,
  sequenceBonus: 0.06,
  minPairScore: 0.52,
  minAverageSimilarity: 0.5,
  maxGroupSize: 100,
  maxTimeSpanSeconds: 60,
  maxSequenceSpan: 12,
  minDiameterScore: 0.52,
};

// Kept for callers from the first implementation.
export const GROUPING_CONFIG = GROUPING_DEFAULTS;

function normalizeConfig(config) {
  return { ...GROUPING_DEFAULTS, ...(config || {}) };
}

function validHash(value) {
  return typeof value === "string" && /^[01]+$/.test(value);
}

function hashSimilarity(left, right, maxDistance) {
  if (!validHash(left) || !validHash(right) || left.length !== right.length) {
    return null;
  }
  const distance = hammingDistance(left, right);
  return Math.max(0, 1 - distance / Math.max(1, maxDistance));
}

function cosineSimilarity(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length ||
    left.length === 0
  ) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function timestamp(item) {
  const value = item.captureTime ?? item.createdAt ?? item.mtimeMs;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function sequenceNumber(item) {
  const value = item.sequenceNumber ?? item.fileSequence;
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(item.name ?? item.fileName ?? item.id ?? "");
  const match = text.match(/(\d+)(?:\.[^.]+)?$/);
  return match ? Number(match[1]) : null;
}

function adjacent(a, b, config) {
  const firstTime = timestamp(a);
  const secondTime = timestamp(b);
  const timeNear =
    firstTime !== null &&
    secondTime !== null &&
    Math.abs(firstTime - secondTime) <= config.timeWindowSeconds * 1000;
  const firstSequence = sequenceNumber(a);
  const secondSequence = sequenceNumber(b);
  const sequenceNear =
    firstSequence !== null &&
    secondSequence !== null &&
    Math.abs(firstSequence - secondSequence) <= config.sequenceWindow;
  return {
    timeNear,
    sequenceNear,
    bonus:
      (timeNear ? config.temporalBonus : 0) +
      (sequenceNear ? config.sequenceBonus : 0),
  };
}

/** Return explainable pair evidence in the range [0, 1]. */
export function pairSimilarity(left, right, config = GROUPING_DEFAULTS) {
  config = normalizeConfig(config);
  const phash = hashSimilarity(
    left.phash ?? left.pHash,
    right.phash ?? right.pHash,
    config.phashDistance,
  );
  const dhash = hashSimilarity(
    left.dhash ?? left.dHash,
    right.dhash ?? right.dHash,
    config.dhashDistance,
  );
  const embedding = cosineSimilarity(
    left.embedding ?? left.vector,
    right.embedding ?? right.vector,
  );
  const coarseHash = Math.max(phash ?? 0, dhash ?? 0);
  const visual =
    embedding !== null
      ? embedding >= config.embeddingSimilarity
        ? embedding
        : coarseHash * 0.35
      : coarseHash;
  const near = adjacent(left, right, config);
  const score = Math.min(1, visual + (visual > 0 ? near.bonus : 0));
  const hasVisualEvidence =
    phash !== null || dhash !== null || embedding !== null;
  const accepted =
    hasVisualEvidence &&
    ((embedding !== null && embedding >= config.embeddingSimilarity) ||
      coarseHash >= 1 - config.phashDistance / 64 ||
      (coarseHash >= 0.45 && near.timeNear && near.sequenceNear) ||
      (near.sequenceNear && near.timeNear)) &&
    score >= config.minPairScore;
  return {
    score,
    accepted,
    phash,
    dhash,
    embedding,
    timeNear: near.timeNear,
    sequenceNear: near.sequenceNear,
  };
}

function averageSimilarity(members, config) {
  if (members.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      total += pairSimilarity(members[left], members[right], config).score;
      count += 1;
    }
  }
  return count ? total / count : 1;
}

function splitByAverage(members, config) {
  if (
    members.length < 3 ||
    averageSimilarity(members, config) >= config.minAverageSimilarity
  ) {
    return [members];
  }
  // Build components after dropping weak links. Components are disjoint, so
  // an item can never be duplicated when a chain is split.
  const parent = members.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const first = find(left);
    const second = find(right);
    if (first !== second) parent[second] = first;
  };
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      if (
        pairSimilarity(members[left], members[right], config).score >=
        config.minAverageSimilarity
      ) {
        union(left, right);
      }
    }
  }
  const components = new Map();
  members.forEach((member, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(member);
  });
  if (components.size === 1) return [members];
  return [...components.values()].flatMap((group) =>
    splitByAverage(group, config),
  );
}

function withinTimeSpan(members, candidate, config) {
  const times = [...members, candidate].map(timestamp).filter((value) => value !== null);
  if (times.length >= 2 && Math.max(...times) - Math.min(...times) > config.maxTimeSpanSeconds * 1000) return false;
  const sequences = [...members, candidate].map(sequenceNumber).filter((value) => value !== null);
  return times.length === members.length + 1 || sequences.length < 2 ||
    Math.max(...sequences) - Math.min(...sequences) <= config.maxSequenceSpan;
}

function* groupingSteps(items, config = GROUPING_DEFAULTS) {
  config = normalizeConfig(config);
  const groups = [];
  const ordered = items.map((item, index) => ({ item, index, time: timestamp(item) }));
  ordered.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.index - b.index);
  // Index group start times; complete-link's span bound makes older groups
  // impossible candidates. Keep legacy inputs in insertion order for parity.
  const buckets = new Map();
  const legacy = [];
  const bucketMs = Math.max(1, config.maxTimeSpanSeconds * 1000);
  const capture = (item) => {
    const value = item.captureTime;
    const time = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(time) ? time : null;
  };
  let comparisons = 0;
  for (const { item } of ordered) {
    yield;
    let selected = null;
    const time = capture(item);
    const key = time === null ? null : Math.floor(time / bucketMs);
    const candidates = key === null ? groups : [...legacy,
      ...(buckets.get(key - 1) || []), ...(buckets.get(key) || []),
      ...(buckets.get(key + 1) || [])].sort((a, b) => a.order - b.order);
    for (const group of candidates) {
      if (++comparisons % 256 === 0) yield;
      if (item.sessionId && group.members.some(member => member.sessionId && member.sessionId !== item.sessionId)) continue;
      if (group.members.length >= config.maxGroupSize) continue;
      if (!withinTimeSpan(group.members, item, config)) continue;
      const compatible = group.members.every(
        (member) => {
          const pair = pairSimilarity(member, item, config);
          return pair.accepted && pair.score >= config.minDiameterScore;
        },
      );
      if (compatible) {
        selected = group;
        break;
      }
    }
    if (selected) selected.members.push(item);
    else {
      const group = { members: [item], order: groups.length };
      groups.push(group);
      if (key === null) legacy.push(group);
      else {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(group);
      }
    }
  }
  const finalGroups = groups.flatMap((group) =>
    splitByAverage(group.members, config),
  );
  return finalGroups.map((members) => ({
    contractVersion: 1,
    id: `group:${members[0].unitId || members[0].id}`,
    unitIds: members.map((item) => item.unitId || item.id),
    items: members,
    size: members.length,
    averageSimilarity: Number(averageSimilarity(members, config).toFixed(4)),
  }));
}

/** Synchronous compatibility API. */
export function groupResults(items, config = GROUPING_DEFAULTS) {
  const steps = groupingSteps(items, config);
  let next;
  do { next = steps.next(); } while (!next.done);
  return next.value;
}

/** Same deterministic partition, yielding to HTTP/cancellation between batches. */
export async function groupResultsAsync(items, config = GROUPING_DEFAULTS, {
  signal, batchSize = 128, onBatch = () => {},
} = {}) {
  const steps = groupingSteps(items, config);
  let count = 0;
  while (true) {
    signal?.throwIfAborted();
    const next = steps.next();
    if (next.done) return next.value;
    if (++count % Math.max(1, batchSize) === 0) {
      onBatch(count);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

/** Exact pHash radius recall across days, separate from burst partitioning.
 * radius+1 disjoint bands guarantee a shared band for every hash within radius.
 * Candidate limits bound returned material; no visual/temporal gate is relaxed.
 */
export async function recallCrossDayDuplicates(items, {
  radius = 4, maxCandidates = 100, signal,
} = {}) {
  if (!Number.isInteger(radius) || radius < 0 || radius > 10) throw new Error("Invalid pHash radius");
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error("Invalid candidate limit");
  const bands = new Map();
  const recalled = new Map();
  let comparisons = 0;
  for (let index = 0; index < items.length; index++) {
    signal?.throwIfAborted();
    if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
    const item = items[index];
    const hash = item.phash ?? item.pHash;
    const time = typeof item.captureTime === "number" ? item.captureTime : Date.parse(item.captureTime || "");
    if (!validHash(hash) || hash.length < radius + 1 || !Number.isFinite(time)) continue;
    const day = Math.floor(time / 86400000);
    const keys = Array.from({ length: radius + 1 }, (_, band) =>
      `${hash.length}:${band}:${hash.slice(Math.floor(band * hash.length / (radius + 1)),
        Math.floor((band + 1) * hash.length / (radius + 1)))}`);
    const seen = new Set();
    const matches = [];
    for (const key of keys) {
      for (const [previousDay, entries] of bands.get(key) || []) {
        if (previousDay === day) continue;
        for (const previous of entries) {
        if (++comparisons % 2048 === 0) {
          signal?.throwIfAborted();
          await new Promise(resolve => setImmediate(resolve));
        }
        if (seen.has(previous.index)) continue;
        seen.add(previous.index);
        if (previous.day !== day && hammingDistance(previous.hash, hash) <= radius) {
          matches.push(items[previous.index].unitId || items[previous.index].id);
          if (matches.length >= maxCandidates) break;
        }
        }
        if (matches.length >= maxCandidates) break;
      }
      if (matches.length >= maxCandidates) break;
    }
    if (matches.length) recalled.set(item.unitId || item.id, matches);
    const entry = { index, day, hash };
    for (const key of keys) {
      if (!bands.has(key)) bands.set(key, new Map());
      const days = bands.get(key);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(entry);
    }
  }
  return recalled;
}

export function clusterByPhash(items, config = GROUPING_DEFAULTS) {
  return groupResults(items, config);
}

export { hammingDistance };
