// Side-by-side numbers for the photos of one group. Sharpness values are only comparable inside a group,
// so they are shown relative to the sharpest photo (100); the other columns are 0–100 model scores.
export const COLUMNS = [
  { key: 'score', label: '总分', name: '总分', title: 'AI 综合分，决定组内名次', unit: 'points' },
  { key: 'quality', label: '画质', name: '画质', title: '画质模型分', unit: 'points' },
  { key: 'sharpness', label: '清晰', name: '清晰度', title: '整图清晰度，组内最清晰的为 100', unit: 'relative' },
  { key: 'eye', label: '眼部', name: '眼部清晰度', title: '眼部清晰度，组内最清晰的为 100', unit: 'relative' },
  { key: 'exposure', label: '曝光', name: '曝光', title: '曝光合适程度', unit: 'points' },
  { key: 'clipped', label: '溢出', name: '溢出', title: '高光和暗部溢出的像素比例，越低越好', unit: 'percent', lower: true },
  { key: 'closed', label: '闭眼', name: '闭眼', title: '闭眼人数 / 检测到的人脸数', unit: 'count', lower: true }
];
// Smallest gap worth mentioning, in the column's own scale.
const NOTABLE = { points: 0.03, relative: 0.1, percent: 0.005, count: 1 };

const metric = (member, key) => {
  if (key === 'closed') return member?.metrics?.faces > 0 ? member.metrics.eyesClosed ?? 0 : null;
  return Number.isFinite(member?.metrics?.[key]) ? member.metrics[key] : null;
};

function scaled(members, column) {
  const values = members.map(member => metric(member, column.key));
  if (column.unit !== 'relative') return values;
  const max = Math.max(...values.filter(value => value !== null));
  return values.map(value => value === null || !(max > 0) ? null : value / max);
}

function cellText(value, unit, member) {
  if (value === null) return '—';
  if (unit === 'count') return `${value}/${member.metrics.faces}`;
  if (unit === 'percent') return value < 0.0005 ? '0' : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  return String(Math.round(value * 100));
}

const spreadOf = values => {
  const known = values.filter(value => value !== null);
  return known.length > 1 ? Math.max(...known) - Math.min(...known) : 0;
};

// Columns where every photo of the group scores about the same say nothing about which to keep; the total score
// always stays because it decides the rank. varyingOnly=false keeps every column with data (difference line).
export function compareTable(members = [], { varyingOnly = true } = {}) {
  if (members.length < 2) return { columns: [], rows: [] };
  const columns = COLUMNS.filter(column => members.some(member => metric(member, column.key) !== null))
    .filter(column => !varyingOnly || column.key === 'score' || spreadOf(scaled(members, column)) >= NOTABLE[column.unit]);
  if (!columns.length) return { columns: [], rows: [] };
  const values = new Map(columns.map(column => [column.key, scaled(members, column)]));
  // A column's best is marked only when it stands out: a real spread and at most two photos sharing it.
  // The total score always marks its leader, since it decides the rank.
  const best = new Map(columns.map(column => {
    const known = values.get(column.key).filter(value => value !== null);
    const target = column.lower ? Math.min(...known) : Math.max(...known);
    const spread = Math.max(...known) - Math.min(...known);
    const stands = column.key === 'score' ? spread > 0
      : spread >= NOTABLE[column.unit] && known.filter(value => value === target).length <= 2;
    return [column.key, known.length > 1 && stands ? target : null];
  }));
  return { columns, rows: members.map((member, index) => ({ ...member, cells: columns.map(column => {
    const value = values.get(column.key)[index];
    return { key: column.key, value, text: cellText(value, column.unit, member), best: value !== null && value === best.get(column.key) };
  }) })) };
}

const FLAG_WORDS = { 'eyes-closed': '闭眼', blurry: '模糊', 'possibly-blurry': '可能模糊', overexposed: '过曝',
  underexposed: '欠曝', noisy: '噪点' };

function gapText(column, gap) {
  const better = column.lower ? gap < 0 : gap > 0;
  const size = Math.abs(gap);
  const amount = column.unit === 'points' ? `${Math.round(size * 100)} 分`
    : column.unit === 'relative' ? `${Math.round(size * 100)}%` : `${(size * 100).toFixed(1)}%`;
  if (column.key === 'clipped') return `溢出${better ? '少' : '多'} ${amount}`;
  if (column.key === 'eye') return `眼部${better ? '更清楚' : '更糊'} ${amount}`;
  return `${column.name}${better ? '高' : '低'} ${amount}`;
}

// One sentence on why this photo ranks where it does: against the best photo, or against the runner-up for the best.
export function differenceLine(members = [], unitId) {
  if (members.length < 2) return '';
  const index = members.findIndex(member => member.unitId === unitId);
  if (index < 0) return '';
  const other = index === 0 ? 1 : 0;
  const { columns, rows } = compareTable(members, { varyingOnly: false });
  const worse = [], better = [];
  for (const [position, column] of columns.entries()) {
    // Closed eyes already come in through the flags.
    if (column.key === 'score' || column.key === 'closed') continue;
    const mine = rows[index].cells[position].value, theirs = rows[other].cells[position].value;
    if (mine === null || theirs === null || Math.abs(mine - theirs) < NOTABLE[column.unit]) continue;
    const text = gapText(column, mine - theirs);
    ((column.lower ? mine < theirs : mine > theirs) ? better : worse).push(text);
  }
  const ownFlags = members[index].flags || [], otherFlags = members[other].flags || [];
  worse.unshift(...ownFlags.filter(flag => !otherFlags.includes(flag)).map(flag => FLAG_WORDS[flag]).filter(Boolean));
  better.unshift(...otherFlags.filter(flag => !ownFlags.includes(flag)).map(flag => FLAG_WORDS[flag])
    .filter(Boolean).map(word => `没有${word}`));
  const scoreGap = (metric(members[index], 'score') ?? 0) - (metric(members[other], 'score') ?? 0);
  const close = Math.abs(scoreGap) < 0.01 ? `，总分只差 ${Math.abs(scoreGap * 100).toFixed(1)}` : '';
  if (index === 0) {
    if (better.length) return `本组第 1 名。比第 2 名：${better.join('、')}${worse.length ? `；但${worse.join('、')}` : ''}`;
    return worse.length ? `本组第 1 名，但比第 2 名${worse.join('、')}，综合分仍更高`
      : `本组第 1 名，和第 2 名几乎一样${close}，看个人喜好`;
  }
  const behind = -scoreGap >= 0.01 ? `总分低 ${Math.round(-scoreGap * 100)} 分` : '';
  if (!worse.length) return behind ? `比第 1 名${behind}，各项差别都不大` : `和第 1 名几乎一样${close}，看个人喜好`;
  return `比第 1 名${behind ? `${behind}，主要是` : '：'}${worse.join('、')}${better.length ? `；但${better.join('、')}` : ''}`;
}

export const FOLD_OVER = 7;
// Large groups keep at most eight rows whatever their size: the top three, the current photo with one neighbour
// either side, and the last one. Skipped runs become one gap row; the distribution bars cover the rest.
export function visibleRows(rows = [], currentIndex = -1, expanded = false) {
  if (expanded || rows.length <= FOLD_OVER) return rows.map(row => ({ row }));
  const keep = rows.map((row, index) => index < 3 || index === rows.length - 1
    || (currentIndex >= 0 && Math.abs(index - currentIndex) <= 1));
  const out = [];
  for (let index = 0; index < rows.length; index++) {
    if (keep[index]) { out.push({ row: rows[index] }); continue; }
    if (out.at(-1)?.gap) out.at(-1).gap++; else out.push({ gap: 1 });
  }
  return out;
}

// One bar per photo in rank order: height is the total score within the group's own range, colour the decision
// (yours, else the AI suggestion).
export function scoreBars(members = []) {
  const scores = members.map(member => metric(member, 'score'));
  const known = scores.filter(value => value !== null);
  const low = Math.min(...known), high = Math.max(...known);
  return members.map((member, index) => ({ unitId: member.unitId, itemIds: member.itemIds || [], rank: member.rank,
    action: member.human || member.suggested, decided: Boolean(member.human), score: scores[index],
    height: scores[index] === null ? 0.5 : high > low ? 0.15 + 0.85 * (scores[index] - low) / (high - low) : 1 }));
}

// 保留前 K 张: the best photo becomes 精选, the rest of the top K 候选, everything below 淘汰. Your own decisions stay.
export function keepTopDecisions(members = [], count = 1) {
  return members.filter(member => !member.human).map(member => ({ unitId: member.unitId,
    action: member.rank === 1 ? 'selected' : member.rank <= count ? 'candidate' : 'rejected',
    reason: `保留前 ${count} 张` }));
}
