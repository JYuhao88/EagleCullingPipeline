import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTable, contrastLines, differenceLine, keepTopDecisions, scoreBars, visibleRows }
  from '../src/plugin/inspector/inspector-compare.js';

test('aesthetic column follows quality and stays neutral in cells and comparison explanations', () => {
  const members = [member('x', 1, { score: 0.6, quality: 0.8, aesthetic: 0.3 }),
    member('y', 2, { score: 0.5, quality: 0.7, aesthetic: 0.9 })];
  const table = compareTable(members);
  assert.deepEqual(table.columns.map(column => column.key), ['score', 'quality', 'aesthetic']);
  const column = table.columns[2];
  assert.equal(column.title, '美学模型参考分（不参与排序）'); assert.equal(column.neutral, true);
  assert.deepEqual(table.rows.map(row => row.cells[2].text), ['30', '90']);
  assert.equal(table.rows.some(row => row.cells[2].best), false);
  assert.doesNotMatch(differenceLine(members, 'y'), /美感/);
});

test('aesthetic column stays visible even when the group scores about the same', () => {
  const members = [member('x', 1, { score: 0.6, quality: 0.8, aesthetic: 0.45 }),
    member('y', 2, { score: 0.5, quality: 0.8, aesthetic: 0.46 })];
  assert.deepEqual(compareTable(members).columns.map(column => column.key), ['score', 'aesthetic']);
});

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
  assert.equal(differenceLine(group, 'a'), '本组第 1 名。比第 2 名：画质高 6 分、清晰度高 25%、溢出少 1.9%');
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
test('eye openness replaces the closed count when blink values exist; face size and similarity are shown but never ranked', () => {
  const members = [[0.6, 0.95, 0.30, null], [0.5, 0.40, 0.20, 0.97], [0.4, 0.90, 0.25, 0.80]].map(([score, eyesOpen, faceSize,
    similar], index) => ({ unitId: `s${index + 1}`, rank: index + 1, suggested: 'candidate',
    metrics: { score, faces: 1, eyesClosed: 0, eyesOpen, faceSize, similar } }));
  const { columns, rows } = compareTable(members);
  assert.deepEqual(columns.map(column => column.key), ['score', 'eyesOpen', 'faceSize', 'similar']);
  assert.deepEqual(rows.map(row => row.cells.map(cell => cell.text)), [['60', '95', '100', '—'], ['50', '40', '67', '97'],
    ['40', '90', '83', '80']]);
  assert.deepEqual(rows.map(row => row.cells.filter(cell => cell.best).map(cell => cell.key)), [['score', 'eyesOpen'], [], []]);
  const line = differenceLine(members, 's2');
  assert.match(line, /睁眼程度低 55 分/);
  assert.doesNotMatch(line, /脸部|相似/);
});

const facts = (extra = {}) => ({ eyes: 'open', cuts: [], blur: false, eyeSharpness: 50, faceSharpness: 80,
  subjectLuma: 100, faceClipped: 0, tilted: false, ...extra });

test('contrast lines name concrete differences against the photo this one competes with', () => {
  const group = [{ unitId: 'a', facts: facts() },
    { unitId: 'b', facts: facts({ eyes: 'closed', cuts: ['脚'], eyeSharpness: 30, subjectLuma: 50 }) }];
  assert.deepEqual(contrastLines(group, 'b', { limit: 9 }), [
    { tone: 'worse', text: '主体闭眼，第 1 名睁眼' }, { tone: 'worse', text: '眼部比第 1 名糊' },
    { tone: 'neutral', text: '这张脚被画面边切到' }, { tone: 'neutral', text: '主体比第 1 名暗约 2 档' }]);
  assert.deepEqual(contrastLines(group, 'a').map(line => line.text),
    ['主体睁眼，第 2 名闭眼', '眼部比第 2 名清楚', '第 2 名脚被画面边切到']);
});

test('contrast lines stay silent on small or unmeasured differences', () => {
  const group = [{ unitId: 'a', facts: facts() }, { unitId: 'b', facts: facts({ eyeSharpness: 45, subjectLuma: 110 }) }];
  assert.deepEqual(contrastLines(group, 'b'), []);
  assert.deepEqual(contrastLines([{ unitId: 'a', facts: facts() }, { unitId: 'b', facts: null }], 'b'), []);
  const unknown = [{ unitId: 'a', facts: facts({ eyes: null }) }, { unitId: 'b', facts: facts({ eyes: 'closed' }) }];
  assert.deepEqual(contrastLines(unknown, 'b'), [{ tone: 'neutral', text: '这张主体闭眼' }]);
});

test('observation differences are appended after the existing eye, crop and focus comparisons', () => {
  const group = [{ unitId: 'a', facts: facts(), observations: [
    { id: 'face-side', text: '侧脸', tone: 'neutral', source: 'rule' },
  ] }, { unitId: 'b', facts: facts(), observations: [
    { id: 'face-front', text: '正脸', tone: 'neutral', source: 'rule' },
    { id: 'background-person', text: '右侧背景有人', tone: 'bad', source: 'rule' },
  ] }];
  assert.deepEqual(contrastLines(group, 'b', { limit: 9 }), [
    { tone: 'neutral', text: '这张是正脸，第 1 名是侧脸' },
  ]);
  assert.deepEqual(contrastLines([{ unitId: 'a', facts: facts() }, { unitId: 'b', facts: facts(), observations: [] }], 'b'), []);
});

const observation = (id, text, tone = 'neutral', extra = {}) => ({ id, text, tone, source: 'rule', ...extra });

test('model silence stays unknown, even when one side has no observation field', () => {
  const members = [{ unitId: 'a', observations: [observation('smile', '在笑', 'good', { source: 'model' })] },
    { unitId: 'b', observations: [observation('mouth', '嘴张开')] }, { unitId: 'c' }];
  assert.deepEqual(contrastLines(members, 'a'), [
    { tone: 'neutral', text: '这张在笑' }, { tone: 'neutral', text: '第 2 名嘴张开' }]);
  assert.deepEqual(contrastLines(members, 'c'), [{ tone: 'neutral', text: '第 1 名在笑' }]);
  assert.deepEqual(contrastLines(members, 'missing'), []);
});

test('opposite statements sharing an id are contrasted only when both are stated', () => {
  const members = [{ unitId: 'a', observations: [observation('smile', '在笑', 'good')] },
    { unitId: 'b', observations: [observation('smile', '没笑', 'bad')] }];
  assert.deepEqual(contrastLines(members, 'a'), [{ tone: 'better', text: '这张在笑，第 2 名没笑' }]);
  assert.deepEqual(contrastLines(members, 'b'), [{ tone: 'worse', text: '这张没笑，第 1 名在笑' }]);
  members[1].observations = [observation('smile', '在笑', 'good')];
  assert.deepEqual(contrastLines(members, 'a'), []);
});

test('closed-eye observations are a fallback without duplicates or invented open eyes', () => {
  const members = [{ unitId: 'a', facts: facts(), observations: [] },
    { unitId: 'b', facts: facts({ eyes: 'closed' }), observations: [observation('eyes-closed', '主体闭眼', 'bad')] }];
  assert.deepEqual(contrastLines(members, 'b'), [{ tone: 'worse', text: '主体闭眼，第 1 名睁眼' }]);
  members[0].facts.eyes = null;
  assert.deepEqual(contrastLines(members, 'b'), [{ tone: 'neutral', text: '这张主体闭眼' }]);
  members[1].facts = null;
  assert.deepEqual(contrastLines(members, 'a'), [{ tone: 'neutral', text: '第 2 名主体闭眼' }]);
  members[0].observations = [observation('eyes-closed', '主体闭眼', 'bad')];
  assert.deepEqual(contrastLines(members, 'a'), []);
});

test('eye focus and expressions precede framing, background and brightness within the three-line limit', () => {
  const members = [{ unitId: 'a', facts: facts(), observations: [observation('background-person', '背景有人')] },
    { unitId: 'b', facts: facts({ eyes: 'closed', eyeSharpness: 20, cuts: ['脚'], subjectLuma: 30 }),
      observations: [observation('smile', '在笑', 'good'), observation('mouth', '嘴张开')] }];
  const snapshot = structuredClone(members);
  assert.deepEqual(contrastLines(members, 'b'), [
    { tone: 'worse', text: '主体闭眼，第 1 名睁眼' }, { tone: 'worse', text: '眼部比第 1 名糊' },
    { tone: 'neutral', text: '这张在笑' }]);
  assert.equal(contrastLines(members, 'b', { limit: 9 })[3].text, '这张嘴张开');
  assert.deepEqual(members, snapshot);
});

test('a one-sided focus location is not a contrast, and raw AF flags are never compared', () => {
  const members = [{ unitId: 'a', facts: facts({ afPointOnEye: true }),
    observations: [{ id: 'focus-eye', text: '对焦点在眼部', tone: 'neutral', source: 'rule' }] },
  { unitId: 'b', facts: facts({ afPointOnEye: false }), observations: [] }];
  assert.deepEqual(contrastLines(members, 'a'), []);
  assert.deepEqual(contrastLines(members, 'b'), []);
});

test('unknown tilt and blur cannot be described as straight or clear; missing cuts cannot mean intact', () => {
  const members = [{ unitId: 'a', facts: { tilted: true, blur: true, cuts: ['手'] } },
    { unitId: 'b', facts: { tilted: null, blur: null, cuts: [] } }];
  assert.deepEqual(contrastLines(members, 'b'), [
    { tone: 'neutral', text: '第 1 名有模糊提示' }, { tone: 'neutral', text: '第 1 名手被画面边切到' },
    { tone: 'neutral', text: '第 1 名有倾斜提示' }]);
  members[1].facts = { tilted: false, blur: false };
  assert.equal(contrastLines(members, 'b')[0].tone, 'better');
  assert.doesNotMatch(differenceLine([member('a', 1, { score: 0.6 }),
    member('b', 2, { score: 0.5 }, ['eyes-closed'])], 'a'), /没有闭眼/);
});

test('background comparison uses the largest valid stated box without identifying a person across frames', () => {
  const large = observation('background-person', '右侧背景有人', 'bad', { box: [0.7, 0.2, 0.9, 0.7] });
  const small = observation('background-person', '左侧背景有人', 'bad', { box: [0.1, 0.2, 0.2, 0.4] });
  const members = [{ unitId: 'a', observations: [large, small] }, { unitId: 'b', observations: [small] }];
  assert.deepEqual(contrastLines(members, 'a'), [{ tone: 'worse', text: '这张入镜路人占比更大' }]);
  assert.deepEqual(contrastLines(members, 'b'), [{ tone: 'better', text: '这张入镜路人占比更小' }]);
  members[0].observations = [{ ...large, box: small.box }];
  assert.deepEqual(contrastLines(members, 'a'), []);
  members[0].observations = [{ ...large, box: [0, 0, -1, 2] }];
  assert.deepEqual(contrastLines(members, 'a'), []);
  members[0].observations = [small];
  assert.deepEqual(contrastLines(members, 'a'), []);
});

test('background presence and position alone do not produce contrast lines on either side', () => {
  const members = [{ unitId: 'a', observations: [observation('background-person', '右侧背景有人', 'bad')] },
    { unitId: 'b', observations: [] }];
  assert.deepEqual(contrastLines(members, 'a'), []);
  assert.deepEqual(contrastLines(members, 'b'), []);
  members[1].observations = [observation('background-person', '左侧背景有人', 'bad')];
  assert.deepEqual(contrastLines(members, 'a'), []);
  assert.deepEqual(contrastLines(members, 'b'), []);
  members[1].observations = undefined;
  assert.deepEqual(contrastLines(members, 'a'), []);
});

test('face direction needs paired front versus side statements, leaving other observations unchanged', () => {
  for (const [id, text] of [['face-front', '正脸'], ['face-side', '侧脸']]) {
    const members = [{ unitId: 'a', observations: [observation(id, text), observation('smile', '在笑', 'good')] },
      { unitId: 'b', observations: [] }];
    assert.deepEqual(contrastLines(members, 'a'), [{ tone: 'neutral', text: '这张在笑' }]);
    assert.deepEqual(contrastLines(members, 'b'), [{ tone: 'neutral', text: '第 1 名在笑' }]);
    members[1].observations = [observation(id, text)];
    assert.deepEqual(contrastLines(members, 'a'), [{ tone: 'neutral', text: '这张在笑' }]);
    members[1].observations = [observation(id === 'face-front' ? 'face-side' : 'face-front', id === 'face-front' ? '侧脸' : '正脸')];
    assert.deepEqual(contrastLines(members, 'a'), [
      { tone: 'neutral', text: '这张在笑' },
      { tone: 'neutral', text: `这张是${text}，第 2 名是${id === 'face-front' ? '侧脸' : '正脸'}` }]);
  }
});

test('tiny background changes and absent facts produce no fabricated differences', () => {
  const members = [{ unitId: 'a', observations: [observation('background-person', '背景有人', 'bad', { box: [0, 0, 0.01, 0.1] })] },
    { unitId: 'b', observations: [observation('background-person', '背景有人', 'bad', { box: [0, 0, 0.02, 0.2] })] }];
  assert.deepEqual(contrastLines(members, 'a'), []);
  assert.deepEqual(contrastLines([{ unitId: 'a' }, { unitId: 'b', observations: [null, {}] }], 'a'), []);
});
