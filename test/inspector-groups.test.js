import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTarget, neighbourGroups, patchRows, runGroups, runProgress, selectionSummary }
  from '../src/plugin/inspector/inspector-groups.js';

const row = (unitId, groupIndex, rank, extra = {}) => ({ unitId, groupId: `g${groupIndex}`, groupIndex, rank,
  primaryItemId: `${unitId}-jpg`, itemIds: [`${unitId}-jpg`, `${unitId}-raw`], suggested: 'candidate', human: null, ...extra });
const rows = [
  row('a2', 0, 2), row('a1', 0, 1, { human: 'selected' }),
  row('b1', 1, 1, { confidence: 'low' }), row('b2', 1, 2, { confidence: 'low', human: 'rejected' }),
  row('c1', 2, 1, { human: 'candidate' }),
  row('d1', 3, 1, { confidence: 'low' })];

test('run groups follow group order, sort by rank and count decisions', () => {
  const groups = runGroups(rows);
  assert.deepEqual(groups.map(group => [group.groupId, group.best.unitId, group.decided, group.done]),
    [['g0', 'a1', 1, false], ['g1', 'b1', 1, false], ['g2', 'c1', 1, true], ['g3', 'd1', 0, false]]);
  assert.deepEqual(runProgress(rows), { total: 6, decided: 3, selected: 1, candidate: 1, rejected: 1, done: false });
  assert.equal(runProgress(rows.map(item => ({ ...item, human: 'selected' }))).done, true);
  assert.equal(runProgress([]).done, false);
});

test('group navigation: prev/next stop at the ends, undecided and uncertain skip done groups and wrap', () => {
  const groups = runGroups(rows);
  assert.equal(groupTarget(groups, 'g0', 'prev'), null);
  assert.equal(groupTarget(groups, 'g0', 'next').unit.unitId, 'b1');
  assert.equal(groupTarget(groups, 'g3', 'next'), null);
  assert.equal(groupTarget(groups, 'g1', 'undecided').group.groupId, 'g3');
  assert.equal(groupTarget(groups, 'g3', 'undecided').unit.unitId, 'a2');
  assert.equal(groupTarget(groups, 'g1', 'uncertain').group.groupId, 'g3');
  assert.equal(groupTarget(groups, 'g3', 'uncertain').unit.unitId, 'b1');
  assert.equal(groupTarget(runGroups([row('x', 0, 1)]), 'g0', 'undecided'), null);
  assert.equal(groupTarget(groups, 'missing', 'undecided').group.groupId, 'g0');
});

test('neighbours, fresh group decisions and multi-select summary', () => {
  const groups = runGroups(rows);
  assert.deepEqual(neighbourGroups(groups, 'g0').map(item => [item.side, item.group.groupId]), [['next', 'g1']]);
  assert.deepEqual(neighbourGroups(groups, 'g2').map(item => [item.side, item.group.groupId]), [['prev', 'g1'], ['next', 'g3']]);
  assert.deepEqual(neighbourGroups(groups, 'missing'), []);
  const patched = patchRows(rows, [{ unitId: 'a2', human: 'rejected' }, { unitId: 'a1', human: null }]);
  assert.deepEqual(patched.filter(item => item.groupId === 'g0').map(item => [item.unitId, item.human, item.action]),
    [['a2', 'rejected', 'rejected'], ['a1', null, 'candidate']]);
  assert.equal(patchRows(rows, [{ unitId: 'a1', human: 'selected' }]), rows);
  const pair = selectionSummary(rows, ['a1-jpg', 'a1-raw']);
  assert.equal(pair.units.length, 1); assert.equal(pair.groupIndex, 0);
  const spread = selectionSummary(rows, ['a1-jpg', 'b2-raw', 'other']);
  assert.deepEqual([spread.units.length, spread.groupCount, spread.unknown, spread.groupIndex], [2, 2, 1, null]);
});
