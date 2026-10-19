import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMoments, momentClusters } from '../src/core/moments.js';
import { groupMembersModel } from '../src/server/item-analysis.js';

// Three poses of one scene: a shared scene vector plus a pose direction and a little per-frame jitter.
const scene = Array.from({ length: 16 }, (_, k) => 1 + k / 16);
const frame = (pose, jitter) => scene.map((x, k) => x + (k % 3 === pose ? 0.6 : 0) + Math.sin(jitter * 7 + k) * 0.05);
const poses = [0, 0, 1, 1, 1, 2, 2, 0, 2];

test('moments split one scene into its poses and leave small, oversized or mixed-length groups alone', () => {
  const clusters = momentClusters(poses.map((pose, i) => frame(pose, i)));
  const byPose = clusters.map(cluster => [...new Set(cluster.map(i => poses[i]))]);
  assert.equal(clusters.length, 3);
  assert.ok(byPose.every(list => list.length === 1), 'each moment holds one pose');
  assert.equal(momentClusters(poses.slice(0, 7).map((pose, i) => frame(pose, i))), null);
  assert.equal(momentClusters(poses.map((pose, i) => frame(pose, i)), { maxUnits: 8 }), null);
  assert.equal(momentClusters([...poses.map((pose, i) => frame(pose, i)), [1, 2]]), null);
});

test('moment leads are the best-ranked frame, numbered by lead rank; frames without vectors stand alone', () => {
  const members = poses.map((pose, i) => ({ unitId: `u${i}`, pose, vector: frame(pose, i) }));
  members.push({ unitId: 'bare', vector: null });
  const moments = groupMoments(members, member => member.vector);
  const of = id => moments.get(members.find(member => member.unitId === id));
  assert.deepEqual(of('u0'), { index: 1, size: 3, lead: true });
  assert.deepEqual(of('u1'), { index: 1, size: 3, lead: false });
  assert.deepEqual(of('u2'), { index: 2, size: 3, lead: true });
  assert.deepEqual(of('u5'), { index: 3, size: 3, lead: true });
  assert.deepEqual(of('bare'), { index: 4, size: 1, lead: true });
  const distinct = poses.map((_, i) => ({ unitId: `d${i}`, vector: scene.map((x, k) => (k === i ? 9 : 0)) }));
  assert.equal(groupMoments(distinct, member => member.vector), null, 'nothing folds, no moments');
});

test('group members carry their moment for the inspector, following AI rank', () => {
  const ids = poses.map((_, i) => `u${i}`);
  const data = { run: { id: 'run-m' }, units: ids.map(id => ({ id, primaryItemId: `${id}-jpg` })),
    results: ids.map((unitId, i) => ({ unitId, embedding: frame(poses[i], i), metrics: {} })) };
  const ranking = [...ids].reverse().map((unitId, i) => ({ unitId, rank: i + 1, score: 1 - i / 10 }));
  const members = groupMembersModel(data, { unitIds: ids, ranking });
  assert.equal(members[0].unitId, 'u8');
  assert.deepEqual(members[0].moment, { index: 1, size: 3, lead: true });
  assert.equal(members.filter(member => member.moment.lead).length, 3);
  assert.equal(groupMembersModel(data, { unitIds: ids.slice(0, 4), ranking }).some(member => member.moment), false);
});
