import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTable, differenceLine, keepTopDecisions, scoreBars, visibleRows }
  from '../src/plugin/inspector/inspector-compare.js';

const member = (unitId, rank, metrics, flags = []) => ({ unitId, rank, itemIds: [unitId], suggested: 'candidate',
  human: null, flags, metrics });
const group = [
  member('a', 1, { score: 0.62, quality: 0.70, sharpness: 0.20, eye: null, exposure: 0.90, clipped: 0.001 }),
  member('b', 2, { score: 0.55, quality: 0.64, sharpness: 0.15, eye: null, exposure: 0.92, clipped: 0.02 }, ['eyes-closed']),
  member('c', 3, { score: 0.618, quality: 0.70, sharpness: 0.20, eye: null, exposure: 0.90, clipped: 0.001 })];

test('comparison table keeps only columns that differ, scales sharpness to the sharpest photo and marks the best', () => {
  const { columns, rows } = compareTable(group);
  assert.deepEqual(columns.map(column => column.label), ['总分', '画质', '清晰', '溢出']);
  assert.deepEqual(compareTable(group, { varyingOnly: false }).columns.map(column => column.label),
    ['总分', '画质', '清晰', '曝光', '溢出']);
  assert.deepEqual(rows.map(row => row.cells.map(cell => cell.text)),
    [['62', '70', '100', '0.1%'], ['55', '64', '75', '2.0%'], ['62', '70', '100', '0.1%']]);
  assert.deepEqual(rows.map(row => row.cells.filter(cell => cell.best).map(cell => cell.key)),
    [['score', 'quality', 'sharpness', 'clipped'], [], ['quality', 'sharpness', 'clipped']]);
  const clippedGroup = (size, prefix) => Array.from({ length: size }, (_, index) => member(`${prefix}${index + 1}`, index + 1,
    { score: 0.49 - index / 100, clipped: index === size - 1 ? 0.02 : 0 }));
  const near = compareTable(clippedGroup(3, 'n'));
  assert.deepEqual(near.rows.map(row => row.cells.map(cell => cell.text)), [['49', '0'], ['48', '0'], ['47', '2.0%']]);
  assert.deepEqual(near.rows.map(row => row.cells[1].best), [true, true, false]);
  const many = compareTable(clippedGroup(4, 'm'));
  assert.equal(many.rows.some(row => row.cells[1].best), false);
  assert.deepEqual(compareTable([group[0]]), { columns: [], rows: [] });
  const tie = compareTable([member('x', 1, { score: 0.5 }), member('y', 2, { score: 0.5 })]);
  assert.equal(tie.rows.some(row => row.cells.some(cell => cell.best)), false);
});

test('difference line explains a lower rank against the best and the best against the runner-up', () => {
  assert.equal(differenceLine(group, 'b'), '比第 1 名总分低 7 分，主要是闭眼、画质低 6 分、清晰度低 25%、溢出多 1.9%');
  const flat = [group[0], { ...group[2], metrics: { ...group[2].metrics, score: 0.58 } }];
  assert.equal(differenceLine(flat, 'c'), '比第 1 名总分低 4 分，各项差别都不大');
  assert.equal(differenceLine(group, 'a'), '本组第 1 名。比第 2 名：没有闭眼、画质高 6 分、清晰度高 25%、溢出少 1.9%');
  assert.equal(differenceLine(group, 'c'), '和第 1 名几乎一样，总分只差 0.2，看个人喜好');
  assert.equal(differenceLine([group[0], group[2]], 'a'), '本组第 1 名，和第 2 名几乎一样，总分只差 0.2，看个人喜好');
  assert.equal(differenceLine([group[0]], 'a'), '');
  assert.equal(differenceLine(group, 'missing'), '');
});

test('large groups show at most eight rows: top three, current with one neighbour each side, the last; gaps between', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ unitId: `u${index + 1}`, rank: index + 1,
    suggested: index === 24 ? 'rejected' : 'candidate', human: index === 10 ? 'rejected' : null }));
  const shape = list => list.map(entry => entry.gap ? `…${entry.gap}` : entry.row.rank).join(' ');
  assert.equal(shape(visibleRows(rows, 20)), '1 2 3 …16 20 21 22 …2 25');
  assert.equal(shape(visibleRows(rows, -1)), '1 2 3 …21 25');
  assert.equal(shape(visibleRows(rows, 1)), '1 2 3 …21 25');
  const hundred = Array.from({ length: 120 }, (_, index) => ({ unitId: `h${index}`, rank: index + 1 }));
  assert.ok(visibleRows(hundred, 60).filter(entry => entry.row).length <= 8);
  assert.equal(visibleRows(rows, 20, true).length, 25);
  assert.equal(visibleRows(rows.slice(0, 7), 5).length, 7);
});

test('distribution bars follow rank with heights inside the group range; keep-top decides only undecided photos', () => {
  const members = [0.6, 0.5, 0.4, 0.3].map((score, index) => ({ unitId: `k${index + 1}`, itemIds: [`p${index + 1}`],
    rank: index + 1, suggested: index ? 'candidate' : 'selected', human: index === 3 ? 'candidate' : null, metrics: { score } }));
  const bars = scoreBars(members);
  assert.deepEqual(bars.map(bar => [bar.rank, bar.height.toFixed(2), bar.action, bar.decided]),
    [[1, '1.00', 'selected', false], [2, '0.72', 'candidate', false], [3, '0.43', 'candidate', false],
      [4, '0.15', 'candidate', true]]);
  assert.deepEqual(keepTopDecisions(members, 2).map(row => [row.unitId, row.action]),
    [['k1', 'selected'], ['k2', 'candidate'], ['k3', 'rejected']]);
  assert.equal(keepTopDecisions(members, 2)[0].reason, '保留前 2 张');
});

test('the closed-eyes column counts closed faces out of detected faces and stays out of the difference sentence', () => {
  const members = [[0.6, 2, 0], [0.5, 2, 1], [0.4, 0, 0]].map(([score, faces, eyesClosed], index) => ({
    unitId: `e${index + 1}`, rank: index + 1, suggested: 'candidate', metrics: { score, faces, eyesClosed } }));
  const { columns, rows } = compareTable(members);
  assert.deepEqual(columns.map(column => column.label), ['总分', '闭眼']);
  assert.deepEqual(rows.map(row => row.cells[1].text), ['0/2', '1/2', '—']);
  assert.equal(differenceLine(members, 'e2'), '比第 1 名总分低 10 分，各项差别都不大');
});
