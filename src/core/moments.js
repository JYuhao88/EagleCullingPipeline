// Moments: runs of near-identical frames inside one shooting group, so a large group reads as a few choices.
// Display only; ranking, rules and grouping never read this.
export const MOMENT_MIN_UNITS = 8;
export const MOMENT_THRESHOLD = 0.1;
// Average-link merging is cubic in the group size; larger groups stay unfolded.
export const MOMENT_MAX_UNITS = 400;

const unit = vector => { const n = Math.hypot(...vector) || 1; return vector.map(x => x / n); };
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

// Average-link clustering on group-centred embeddings: raw embeddings of one scene are all ~0.9 similar.
// Returns index lists, or null when the group is outside the size range or vectors disagree in length.
export function momentClusters(embeddings, { threshold = MOMENT_THRESHOLD, minUnits = MOMENT_MIN_UNITS,
  maxUnits = MOMENT_MAX_UNITS } = {}) {
  const n = embeddings.length;
  if (n < minUnits || n > maxUnits || embeddings.some(vector => vector.length !== embeddings[0].length)) return null;
  const raw = embeddings.map(unit);
  const mean = raw[0].map((_, k) => raw.reduce((sum, v) => sum + v[k], 0) / n);
  const centred = raw.map(v => unit(v.map((x, k) => x - mean[k])));
  const similarity = centred.map(a => centred.map(b => dot(a, b)));
  const members = centred.map((_, i) => [i]);
  const alive = [...members.keys()];
  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let x = 0; x < alive.length; x++) for (let y = x + 1; y < alive.length; y++) {
      if (similarity[alive[x]][alive[y]] > best) { best = similarity[alive[x]][alive[y]]; bi = alive[x]; bj = alive[y]; }
    }
    if (bi < 0 || best < threshold) break;
    const a = members[bi].length, b = members[bj].length;
    for (const k of alive) if (k !== bi && k !== bj) {
      similarity[bi][k] = similarity[k][bi] = (a * similarity[bi][k] + b * similarity[bj][k]) / (a + b);
    }
    members[bi] = members[bi].concat(members[bj]);
    alive.splice(alive.indexOf(bj), 1);
  }
  return alive.map(i => members[i]);
}

// Moments for rank-ordered group members: each member gets { index, size, lead }, the lead being the best-ranked
// frame of its moment and moments numbered by their lead's rank. Members without an embedding stand alone.
// Null when nothing folds.
export function groupMoments(members, embeddingOf, options) {
  const known = members.filter(member => Array.isArray(embeddingOf(member)));
  const clusters = momentClusters(known.map(embeddingOf), options);
  if (!clusters || clusters.length === known.length) return null;
  const moment = new Map();
  for (const cluster of clusters) for (const i of cluster) moment.set(known[i], cluster.map(j => known[j]));
  const out = new Map();
  let index = 0;
  for (const member of members) {
    if (out.has(member)) continue;
    const group = moment.get(member) || [member];
    index++;
    for (const other of group) out.set(other, { index, size: group.length, lead: other === member });
  }
  return out;
}
