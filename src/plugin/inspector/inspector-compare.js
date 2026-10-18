// Side-by-side numbers for the photos of one group. Sharpness values are only comparable inside a group,
// so they are shown relative to the sharpest photo (100); the other columns are 0–100 model scores.
export const COLUMNS = [
  { key: 'score', label: '总分', name: '总分', title: 'AI 综合分，决定组内名次', unit: 'points' },
  { key: 'quality', label: '画质', name: '画质', title: '画质模型分', unit: 'points' },
  { key: 'aesthetic', label: '美感', name: '美感', title: '美学模型参考分（不参与排序）', unit: 'points', neutral: true,
    always: true },
  { key: 'sharpness', label: '清晰', name: '清晰度', title: '整图清晰度，组内最清晰的为 100', unit: 'relative' },
  { key: 'eye', label: '眼部', name: '眼部清晰度', title: '眼部清晰度，组内最清晰的为 100', unit: 'relative' },
  { key: 'exposure', label: '曝光', name: '曝光', title: '曝光合适程度', unit: 'points' },
  { key: 'clipped', label: '溢出', name: '溢出', title: '高光和暗部溢出的像素比例，越低越好', unit: 'percent', lower: true },
  { key: 'eyesOpen', label: '睁眼', name: '睁眼程度', title: '最没睁开的那只眼：0 闭眼，100 完全睁开', unit: 'points' },
  // Older runs have no per-eye blink values; they keep the plain count.
  { key: 'closed', label: '闭眼', name: '闭眼', title: '闭眼人数 / 检测到的人脸数', unit: 'count', lower: true,
    fallbackFor: 'eyesOpen' },
  // Reference only: neither a bigger face nor a closer twin is better, so these get no highlight or sentence.
  { key: 'faceSize', label: '脸大', name: '脸部大小', title: '最大人脸占画面的高度，组内最大的为 100（取景远近）',
    unit: 'relative', neutral: true },
  { key: 'similar', label: '相似', name: '与第 1 名相似度', title: '与本组第 1 名的画面相似度，接近 100 的几乎是同一张',
    unit: 'points', neutral: true }
];
// Smallest gap worth mentioning, in the column's own scale.
const NOTABLE = { points: 0.03, relative: 0.1, percent: 0.005, count: 1 };
// Which columns survive first when the panel is too narrow for all of them.
const KEEP_ORDER = ['score', 'eyesOpen', 'closed', 'eye', 'aesthetic', 'sharpness', 'quality', 'exposure', 'clipped',
  'faceSize', 'similar'];
// Mirrors inspector.css: the thumbnail column is 41px, the rank column 5.2em, and a data column needs about 2.7em.
export function columnSlots(width, fontSize = 11) {
  if (!(width > 0)) return Infinity;
  return Math.max(1, Math.floor(((width - 41) * 10 - 52 * fontSize) / (27 * fontSize)));
}

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
// slots caps the data columns; the ones that do not fit come back as hidden.
export function compareTable(members = [], { varyingOnly = true, slots = Infinity } = {}) {
  if (members.length < 2) return { columns: [], rows: [] };
  const has = key => members.some(member => metric(member, key) !== null);
  const present = COLUMNS.filter(column => has(column.key) && !(column.fallbackFor && has(column.fallbackFor)))
    .filter(column => !varyingOnly || column.key === 'score' || column.always
      || spreadOf(scaled(members, column)) >= NOTABLE[column.unit]);
  if (!present.length) return { columns: [], rows: [] };
  const kept = new Set([...present].sort((a, b) => KEEP_ORDER.indexOf(a.key) - KEEP_ORDER.indexOf(b.key))
    .slice(0, Math.max(1, slots)));
  const columns = present.filter(column => kept.has(column)), hidden = present.filter(column => !kept.has(column));
  const values = new Map(columns.map(column => [column.key, scaled(members, column)]));
  // A column's best is marked only when it stands out: a real spread and at most two photos sharing it.
  // The total score always marks its leader, since it decides the rank.
  const best = new Map(columns.map(column => {
    const known = values.get(column.key).filter(value => value !== null);
    const target = column.lower ? Math.min(...known) : Math.max(...known);
    const spread = Math.max(...known) - Math.min(...known);
    const stands = column.key === 'score' ? spread > 0 : !column.neutral
      && spread >= NOTABLE[column.unit] && known.filter(value => value === target).length <= 2;
    return [column.key, known.length > 1 && stands ? target : null];
  }));
  return { columns, hidden, rows: members.map((member, index) => ({ ...member, cells: columns.map(column => {
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
    if (column.key === 'score' || column.key === 'closed' || column.neutral) continue;
    const mine = rows[index].cells[position].value, theirs = rows[other].cells[position].value;
    if (mine === null || theirs === null || Math.abs(mine - theirs) < NOTABLE[column.unit]) continue;
    const text = gapText(column, mine - theirs);
    ((column.lower ? mine < theirs : mine > theirs) ? better : worse).push(text);
  }
  const ownFlags = members[index].flags || [], otherFlags = members[other].flags || [];
  worse.unshift(...ownFlags.filter(flag => !otherFlags.includes(flag)).map(flag => FLAG_WORDS[flag]).filter(Boolean));
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

// Sharpness ratio and brightness gap (in stops) below which two photos read as the same to the eye.
const SHARPER = 1.3, STOPS = 0.7, CLIPPED_FACE = 0.02, CLEAN_FACE = 0.005;
const toLinear = luma => { const v = luma / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const stopsText = stops => `${Math.round(Math.abs(stops) * 2) / 2} 档`;

// The top pick compares with the runner-up; everyone else compares with the top pick. Missing evidence is
// unknown, including a missing observation or a rule that did not run. These sentences never change ranking.
export function contrastLines(members = [], unitId, { limit = 3 } = {}) {
  const index = members.findIndex(member => member.unitId === unitId);
  if (members.length < 2 || index < 0) return [];
  const current = members[index], other = members[index === 0 ? 1 : 0];
  const mine = current.facts || {}, theirs = other.facts || {};
  const own = observationMap(current.observations), peer = observationMap(other.observations);
  const them = index === 0 ? '第 2 名' : '第 1 名';
  const lines = [];
  const add = (tone, text) => lines.push({ tone, text });
  // Closed-eye observations repeat the same rule as photoFacts; use them only as a fallback.
  const eyes = (facts, observations) => ['open', 'closed'].includes(facts.eyes) ? facts.eyes
    : observations.has('eyes-closed') ? 'closed' : null;
  const myEyes = eyes(mine, own), theirEyes = eyes(theirs, peer);
  if (myEyes && theirEyes && myEyes !== theirEyes)
    add(myEyes === 'open' ? 'better' : 'worse', myEyes === 'open' ? `主体睁眼，${them}闭眼` : `主体闭眼，${them}睁眼`);
  else if (myEyes !== theirEyes && (myEyes === 'closed' || theirEyes === 'closed'))
    add('neutral', myEyes === 'closed' ? '这张主体闭眼' : `${them}主体闭眼`);
  own.delete('eyes-closed'); peer.delete('eyes-closed');
  if (mine.blur !== theirs.blur) {
    if (typeof mine.blur === 'boolean' && typeof theirs.blur === 'boolean')
      add(mine.blur ? 'worse' : 'better', mine.blur ? `这张有模糊提示，${them}未触发` : `${them}有模糊提示，这张未触发`);
    else if (mine.blur === true || theirs.blur === true)
      add('neutral', mine.blur === true ? '这张有模糊提示' : `${them}有模糊提示`);
  }
  const [part, a, b] = mine.eyeSharpness > 0 && theirs.eyeSharpness > 0 ? ['眼部', mine.eyeSharpness, theirs.eyeSharpness]
    : ['脸部', mine.faceSharpness, theirs.faceSharpness];
  if (a > 0 && b > 0 && Math.max(a / b, b / a) >= SHARPER)
    add(a > b ? 'better' : 'worse', `${part}比${them}${a > b ? '清楚' : '糊'}`);
  // A focus location missing on one side is unknown, not elsewhere; it stays in the observation list only.
  own.delete('focus-eye'); peer.delete('focus-eye');
  addObservationContrast(lines, own, peer, them, ['smile', 'mouth']);
  for (const [facts, otherFacts, who] of [[mine, theirs, '这张'], [theirs, mine, them]]) {
    const cuts = (facts.cuts || []).filter(part => !(otherFacts.cuts || []).includes(part));
    if (cuts.length) add('neutral', `${who}${cuts.join('、')}被画面边切到`);
  }
  if (Number.isFinite(mine.faceClipped) && Number.isFinite(theirs.faceClipped)) {
    if (mine.faceClipped >= CLIPPED_FACE && theirs.faceClipped < CLEAN_FACE) add('worse', `脸部高光溢出比${them}多`);
    if (theirs.faceClipped >= CLIPPED_FACE && mine.faceClipped < CLEAN_FACE) add('better', `脸部高光溢出比${them}少`);
  }
  if (mine.tilted !== theirs.tilted) {
    if (typeof mine.tilted === 'boolean' && typeof theirs.tilted === 'boolean')
      add(mine.tilted ? 'worse' : 'better', mine.tilted ? `这张有倾斜提示，${them}未触发` : `${them}有倾斜提示，这张未触发`);
    else if (mine.tilted === true || theirs.tilted === true)
      add('neutral', mine.tilted === true ? '这张有倾斜提示' : `${them}有倾斜提示`);
  }
  addObservationContrast(lines, own, peer, them);
  if (mine.subjectLuma > 0 && theirs.subjectLuma > 0) {
    const stops = Math.log2(toLinear(mine.subjectLuma) / toLinear(theirs.subjectLuma));
    if (Math.abs(stops) >= STOPS) add('neutral', `主体比${them}${stops > 0 ? '亮' : '暗'}约 ${stopsText(stops)}`);
  }
  return lines.slice(0, limit);
}

const boxArea = box => Array.isArray(box) && box.length === 4
  && box.every(v => Number.isFinite(v) && v >= 0 && v <= 1) && box[2] > box[0] && box[3] > box[1]
  ? (box[2] - box[0]) * (box[3] - box[1]) : 0;

function observationMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || typeof item.text !== 'string' || !item.text.trim()) continue;
    const previous = map.get(item.id);
    if (!previous || item.id === 'background-person' && boxArea(item.box) > boxArea(previous.box)) map.set(item.id, item);
  }
  return map;
}

function addObservationContrast(lines, mine, theirs, them, ids) {
  if (!ids) {
    const faceMine = ['face-front', 'face-side'].find(id => mine.has(id));
    const faceOther = ['face-front', 'face-side'].find(id => theirs.has(id));
    if (faceMine && faceOther && faceMine !== faceOther) {
      lines.push({ tone: 'neutral', text: `这张是${mine.get(faceMine).text}，${them}是${theirs.get(faceOther).text}` });
      mine.delete(faceMine); theirs.delete(faceOther);
    }
  }
  for (const id of ids || new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(id), b = theirs.get(id);
    mine.delete(id); theirs.delete(id);
    if (!a && !b) continue;
    if (id === 'face-front' || id === 'face-side') continue;
    if (id === 'background-person') {
      const sizeA = boxArea(a?.box), sizeB = boxArea(b?.box);
      if (sizeA > 0 && sizeB > 0
        && Math.max(sizeA / sizeB, sizeB / sizeA) >= 2 && Math.abs(sizeA - sizeB) >= 0.005) {
        lines.push({ tone: sizeA > sizeB ? 'worse' : 'better', text: `这张入镜路人占比更${sizeA > sizeB ? '大' : '小'}` });
      }
      continue;
    }
    if (a && b) {
      if (a.text === b.text) continue;
      const tone = a.tone === 'good' && b.tone === 'bad' ? 'better'
        : a.tone === 'bad' && b.tone === 'good' ? 'worse' : 'neutral';
      lines.push({ tone, text: `这张${a.text}，${them}${b.text}` });
    } else lines.push({ tone: 'neutral', text: a ? `这张${a.text}` : `${them}${b.text}` });
  }
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
