import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FEATURE_KEYS, preferenceVector, preferenceSamples, fitPreferenceHead, preferenceScore,
  temporalSplit, evaluatePreferenceHead, learningCurve, driftReport, eventsToPreferenceGroups } from "../src/core/preference-head.js";
import { PreferenceStore } from "../src/core/preference-store.js";

function fixture(count = 80) {
  return Array.from({ length: count }, (_, index) => ({ id: `group-${index}`, runId: `run-${index % 3}`,
    profileId: "default", time: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    signal: "explicit", winners: [`${index}-dark`], candidates: [
      { hash: `${index}-bright`, baselineScore: 0.9, feature: { metrics: { exposure: 0.8, raw: { meanLuma: 180 } } } },
      { hash: `${index}-dark`, baselineScore: 0.1, feature: { metrics: { exposure: 0.6, raw: { meanLuma: 70 } } } },
    ] }));
}

test("L1 supports negative tastes, DINO projection and explicit missing masks", () => {
  const head = fitPreferenceHead(fixture());
  const [bright, dark] = fixture()[0].candidates;
  assert.ok(preferenceScore(dark.feature, head) > preferenceScore(bright.feature, head));
  assert.ok(head.weights[FEATURE_KEYS.indexOf("brightness")] < 0);
  const missing = preferenceVector({ metrics: { focus: "na" }, embedding: "na" });
  const measured = preferenceVector({ metrics: { focus: 0 }, embedding: [1, 0, 0] });
  assert.equal(missing[FEATURE_KEYS.length + FEATURE_KEYS.indexOf("focus")], 1);
  assert.equal(measured[FEATURE_KEYS.length + FEATURE_KEYS.indexOf("focus")], 0);
  assert.notDeepEqual(missing, measured);
  assert.notDeepEqual(preferenceVector({ genre: "portrait", metrics: { sharpness: 0.8 } }),
    preferenceVector({ genre: "landscape", metrics: { sharpness: 0.8 } }));
  assert.deepEqual(measured, preferenceVector({ metrics: { focus: 0 }, embedding: [1, 0, 0] }));
});

test("correction beats explicit choice beats bulk; ties are neutral and all-reject invents no winner", () => {
  const group = fixture(1)[0];
  const weight = signal => preferenceSamples([{ ...group, signal }])[0].weight;
  assert.ok(weight("corrected") > weight("explicit"));
  assert.ok(weight("explicit") > weight("bulk"));
  const tied = preferenceSamples([{ ...group, winners: group.candidates.map(candidate => candidate.hash), tie: true }]);
  assert.equal(tied[0].target, 0.5);
  assert.equal(preferenceSamples([{ ...group, winners: [] }]).length, 0);
  assert.equal(preferenceSamples([{ ...group, winners: [], rejectedHashes: group.candidates.map(candidate => candidate.hash) }]).length, 0);
  const tombstone = preferenceSamples([{ ...group, winners: [], rejectedHashes: [group.candidates[0].hash], signal: "tombstone" }]);
  assert.equal(tombstone[0].target, 0);
});

test("temporal evaluation purges repeated content and cannot self-evaluate training labels", () => {
  const groups = fixture();
  groups[0].candidates[0].hash = groups.at(-1).candidates[0].hash;
  const split = temporalSplit(groups);
  assert.equal(split.purgedGroups, 1);
  assert.ok(split.train.every(group => group.time < split.test[0].time));
  const training = new Set(split.train.flatMap(group => group.candidates.map(candidate => candidate.hash)));
  assert.ok(split.test.every(group => group.candidates.every(candidate => !training.has(candidate.hash))));
  const report = evaluatePreferenceHead(groups);
  assert.equal(report.ready, true);
  assert.equal(report.before.estimate, 0);
  assert.equal(report.after.estimate, 1);
  assert.ok(report.improvement.lower > 0);
  assert.ok(report.sampleCount < groups.length);
  assert.ok(report.pairCount > 0);
  assert.equal(report.metrics.after.ndcgAt5.estimate, 1);
  assert.equal(evaluatePreferenceHead(fixture(1)).reason, "insufficient-data");
  assert.equal(evaluatePreferenceHead(groups.map(group => ({ ...group, signal: "bulk" }))).ready, false);
  const tiedTimes = groups.map(group => ({ ...group, time: groups[0].time }));
  assert.equal(evaluatePreferenceHead(tiedTimes).ready, false);
});

test("learning curve has local checkpoints and gate refuses a baseline that is already correct", () => {
  const groups = fixture(320);
  assert.deepEqual(learningCurve(groups).map(point => point.groups), [10, 25, 50, 100, 200]);
  assert.ok(learningCurve(groups).every(point => point.improvement.lower > 0));
  groups.forEach(group => group.candidates.forEach(candidate => {
    candidate.baselineScore = group.winners.includes(candidate.hash) ? 1 : 0;
  }));
  assert.equal(evaluatePreferenceHead(groups).reason, "no-stable-heldout-improvement");
});

test("time decay learns preference switch and recent agreement flags drift without queueing", () => {
  const old = fixture(120);
  const head = fitPreferenceHead(old);
  const changed = fixture(160).slice(120).map(group => ({ ...group, winners: [group.candidates[0].hash] }));
  const drift = driftReport([...old, ...changed], head, { recentGroups: 25 });
  assert.equal(drift.detected, true);
  assert.equal(drift.uncertaintyOnly, true);
  const decayed = fitPreferenceHead([...old, ...changed], { halfLifeDays: 3 });
  assert.ok(preferenceScore(changed[0].candidates[0].feature, decayed) > preferenceScore(changed[0].candidates[1].feature, decayed));
  const samples = preferenceSamples(old, { halfLifeDays: 2 });
  assert.ok(samples[0].weight < samples.at(-1).weight / 100);
});

test("events adapt full-group snapshots, undo and deletion negatives without creating all-reject winners", () => {
  const group = fixture(1)[0];
  const features = new Map(group.candidates.map(candidate => [candidate.hash, candidate.feature]));
  const first = { id: "e1", type: "decision", timestamp: group.time, runId: "r", groupId: "g",
    candidateHashes: group.candidates.map(candidate => candidate.hash), winners: group.winners,
    ai: { ranking: group.candidates.map(candidate => ({ hash: candidate.hash, score: candidate.baselineScore })) } };
  assert.equal(eventsToPreferenceGroups([first], features)[0].winners[0], group.winners[0]);
  assert.deepEqual(eventsToPreferenceGroups([first, { id: "e2", type: "undo", targetEventId: "e1" }], features), []);
  const deletion = { ...first, id: "e3", type: "tombstone", hash: group.candidates[0].hash, winners: [] };
  const adapted = eventsToPreferenceGroups([deletion], features);
  assert.equal(adapted[0].signal, "tombstone");
  assert.equal(preferenceSamples(adapted)[0].target, 0);
  const reset = { ...first, id: "e4", type: "undo", winners: [], timestamp: "2026-12-01T00:00:00Z" };
  assert.equal(eventsToPreferenceGroups([first, reset], features).length, 0);
  const bareDeletion = { id: "e5", type: "tombstone", timestamp: "2026-12-02T00:00:00Z",
    runId: "r", groupId: "g", hash: group.candidates[0].hash };
  assert.equal(eventsToPreferenceGroups([first, bareDeletion], features)[0].rejectedHashes[0], bareDeletion.hash);
  const exposure = { ...first, id: 'shown-again', type: 'exposure', winners: undefined,
    timestamp: '2026-12-01T00:00:00Z' };
  assert.deepEqual(eventsToPreferenceGroups([first, exposure, bareDeletion], features)[0].winners, group.winners);
  const allDeleted = { ...bareDeletion, id: "e6", hash: group.candidates[1].hash, timestamp: "2026-12-03T00:00:00Z" };
  const deletedGroups = eventsToPreferenceGroups([first, bareDeletion, allDeleted], features);
  assert.equal(deletedGroups[0].winners.length, 0);
  assert.equal(preferenceSamples(deletedGroups).length, 0);
});

test("evaluation uses L0 ranking and preserves safety strata exactly as deployed", () => {
  const groups = fixture();
  for (const group of groups) {
    group.candidates[0].baselineRank = 1;
    group.candidates[0].tier = 0;
    group.candidates[1].baselineRank = 2;
    group.candidates[1].tier = 2;
  }
  const report = evaluatePreferenceHead(groups);
  assert.equal(report.ready, false);
  assert.equal(report.after.estimate, 0);
  groups.forEach(group => { group.candidates[0].baselineRank = 2; group.candidates[1].baselineRank = 1; });
  assert.equal(evaluatePreferenceHead(groups).before.estimate, 1);
});

test("profiles default disabled, persist across instances, rollback exact head and validate config", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-l1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PreferenceStore(root);
  assert.equal((await store.loadProfile()).config.enabled, false);
  assert.equal((await store.loadProfile()).config.pixelTier, 0);
  await store.saveConfig("default", { enabled: true, halfLifeDays: 20 });
  const first = await store.train("default", fixture());
  const second = await store.train("default", fixture().map(group => ({ ...group, winners: [group.candidates[0].hash] })));
  assert.notEqual(first.version, second.version);
  assert.equal((await new PreferenceStore(root).loadProfile()).version, second.version);
  const restored = await store.rollback("default", first.version);
  assert.deepEqual(restored.head, first.head);
  assert.equal(restored.config.enabled, true);
  const isolated = await store.train("client", fixture());
  assert.equal(isolated.head.trainingGroups, 0);
  await assert.rejects(store.saveConfig("default", { halfLifeDays: -1 }));
  await assert.rejects(store.rollback("default", "../bad"));
  await assert.rejects(store.loadProfile("../../bad"));
  assert.equal((await store.listProfiles()).length, 2);
});

test('drift detects a meaningful window decline and refuses stable or incomplete windows', () => {
  const groups = fixture(50), head = fitPreferenceHead(groups);
  groups.forEach((g, i) => { if (i < 25 ? i >= 15 : i >= 31) g.winners = [g.candidates[0].hash]; });
  const report = driftReport(groups, head);
  assert.equal(report.drop, 0.36);

  assert.ok(report.difference.lower > 0);
  assert.equal(report.detected, true);
  assert.equal(driftReport(fixture(50), head).detected, false);
  assert.equal(driftReport(fixture(49), head).reason, 'insufficient-data');
});

test('stationary drift calibration reports reproducible false alarms below ten percent', async () => {
  const { calibrateDrift } = await import('../scripts/simulate-drift-calibration.mjs');
  const calibration = calibrateDrift({ trials: 100 });
  assert.ok(calibration.conditions.every(c => c.falseAlarmRate < 0.1));
  assert.ok(calibration.conditions.every(c => c.windows === 100 && c.falseAlarmRate === c.falseAlarms / c.windows));
});
