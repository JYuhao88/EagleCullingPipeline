import { seededRandom } from '../../src/core/pick-eval.js';
import { rankGroup, suggestDecision } from '../../src/core/ranking.js';

const ratio = (hits, total) => ({ hits, total, rate: total ? hits / total : null });
function confidence(values, iterations = 1000, seed = 42) {
  if (!values.length) return { low: null, high: null, samples: 0 };
  const rng = seededRandom(seed);
  const means = Array.from({ length: iterations }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rng() * values.length)];
    return sum / values.length;
  }).sort((a, b) => a - b);
  return { low: means[Math.floor(iterations * .025)], high: means[Math.min(iterations - 1, Math.floor(iterations * .975))],
    samples: iterations };
}
function pairedSummary(rows, iterations, seed) {
  const total = rows.reduce((s, r) => s + r.total, 0), hits = rows.reduce((s, r) => s + r.hits, 0);
  if (!total) return { ...ratio(0, 0), ci: { low: null, high: null, samples: 0 } };
  const rng = seededRandom(seed), means = [];
  for (let b = 0; b < iterations; b++) {
    let h = 0, t = 0;
    for (let i = 0; i < rows.length; i++) { const r = rows[Math.floor(rng() * rows.length)]; h += r.hits; t += r.total; }
    if (t) means.push(h / t);
  }
  means.sort((a, b) => a - b);
  return { ...ratio(hits, total), ci: { low: means[Math.floor(means.length * .025)],
    high: means[Math.min(means.length - 1, Math.floor(means.length * .975))], samples: means.length } };
}
export function evaluateSynthetic(manifest, results, { bootstrap = 1000, seed = 42 } = {}) {
  if (!manifest.pairs?.length) throw new Error('Synthetic manifest requires nonempty pairs');
  const lookup = new Map(results.map(r => [r.unitId, r]));
  const categories = {}, sources = new Map(), rows = [];
  for (const pair of manifest.pairs) {
    const source = lookup.get(pair.sourceId), degraded = lookup.get(pair.degradedId);
    if (!source || !degraded) throw new Error(`Missing synthetic result: ${pair.sourceStem}/${pair.degradation}`);
    const ranked = rankGroup([source, degraded]);
    const a = ranked.find(r => r.unitId === source.unitId), b = ranked.find(r => r.unitId === degraded.unitId);
    // Numeric ties receive half credit; IDs must never become evidence of preference.
    const credit = a.score === b.score ? .5 : a.score > b.score ? 1 : 0;
    const pairDecision = suggestDecision(b, degraded, 2);
    const gateRejected = pairDecision === 'rejected';
    const standaloneGateRejected = suggestDecision({ rank: 1 }, degraded, 1) === 'rejected';
    const sourceRejected = suggestDecision({ rank: 1 }, source, 1) === 'rejected';
    sources.set(pair.sourceId, sourceRejected);
    const row = { ...pair, sourceScore: a.score, degradedScore: b.score, credit,
      gateRejected, standaloneGateRejected, sourceRejected, pairDecision,
      sourceFlags: source.flags, flags: degraded.flags, verdicts: degraded.verdicts };
    rows.push(row);
    (categories[pair.degradation] ??= []).push(row);
  }
  const summarize = list => ({ pairs: list.length, accuracy: list.filter(r => r.credit === 1).length / list.length,
    tieAdjustedAccuracy: list.reduce((s, r) => s + r.credit, 0) / list.length,
    ties: list.filter(r => r.credit === .5).length,
    // Resample source clusters, preserving dependence between strengths and degradation types.
    ci: pairedSummary([...new Set(list.map(r => r.sourceId))].map(id => {
      const cluster = list.filter(r => r.sourceId === id);
      return { hits: cluster.filter(r => r.credit === 1).length, total: cluster.length };
    }), bootstrap, seed).ci,
    gate: ratio(list.filter(r => r.expectedGate && r.gateRejected).length, list.filter(r => r.expectedGate).length) });
  const sourceValues = [...sources.values()].map(Number);
  return { status: 'completed', ...summarize(rows), sourceCount: sources.size,
    sourceFalseReject: { assumption: 'All technically screened sources are retained controls; no independent aesthetic labels',
      ...ratio(sourceValues.reduce((s, v) => s + v, 0), sources.size),
      ci: confidence(sourceValues, bootstrap, seed) },
    byDegradation: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, summarize(v)])), rows };
}
export function evaluateTriage(manifest, results, { bootstrap = 1000, seed = 42 } = {}) {
  if (manifest.status !== 'ready') return { status: manifest.status ?? 'unavailable', reason: manifest.reason, groups: 0,
    top1: null, pairwise: null, random: null, chronological: null };
  if (manifest.license?.status !== 'verified' || !manifest.groups?.length)
    throw new Error('Triage requires verified license and nonempty official holdout groups');
  if (manifest.groups.some(g => !['validation', 'test'].includes(g.split)))
    throw new Error('Triage only evaluates official validation/test splits');
  const lookup = new Map(results.map(r => [r.unitId, r]));
  const rows = manifest.groups.map(group => {
    const ids = new Set(group.images.map(image => image.id));
    const preferred = group.preferredIds ?? [group.preferredId];
    if (group.images.length < 2 || ids.size !== group.images.length || !preferred.length ||
      preferred.some(id => !ids.has(id)) || group.images.some(image => !Number.isFinite(image.order)))
      throw new Error(`Invalid triage series metadata: ${group.id}`);
    if (group.pairs.some(p => !ids.has(p.winnerId) || !ids.has(p.loserId) || p.winnerId === p.loserId ||
      !Number.isFinite(p.strength) || p.strength < .5 || p.strength > 1))
      throw new Error(`Invalid triage preference: ${group.id}`);
    const items = group.images.map(image => {
      const r = lookup.get(image.id);
      if (!r) throw new Error(`Missing triage result: ${image.id}`);
      return r;
    });
    const ranking = rankGroup(items), scores = new Map(ranking.map(r => [r.unitId, r.score]));
    const max = Math.max(...scores.values()), tied = [...scores].filter(([, s]) => s === max).map(([id]) => id);
    const winners = group.preferredIds ?? [group.preferredId];
    const strong = group.pairs.filter(pair => pair.strength >= .7);
    const credit = strong.map(p => scores.get(p.winnerId) === scores.get(p.loserId) ? .5 :
      scores.get(p.winnerId) > scores.get(p.loserId) ? 1 : 0);
    const time = [...group.images].sort((a, b) => a.order - b.order);
    const position = new Map(time.map((v, i) => [v.id, i]));
    return { id: group.id, top1: tied.filter(id => winners.includes(id)).length / tied.length,
      randomTop1: winners.length / items.length, timeTop1: Number(winners.includes(time[0].id)),
      pairwise: { hits: credit.reduce((s, v) => s + v, 0), total: strong.length },
      timePairwise: { hits: strong.filter(p => position.get(p.winnerId) < position.get(p.loserId)).length, total: strong.length } };
  });
  const summarize = key => ({ rate: rows.reduce((s, r) => s + r[key], 0) / rows.length,
    ci: confidence(rows.map(r => r[key]), bootstrap, seed) });
  return { status: 'completed', groups: rows.length, top1: summarize('top1'),
    pairwise: pairedSummary(rows.map(r => r.pairwise), bootstrap, seed),
    random: { top1: summarize('randomTop1'), pairwise: { rate: .5 } },
    chronological: { top1: summarize('timeTop1'), pairwise: pairedSummary(rows.map(r => r.timePairwise), bootstrap, seed) }, rows };
}

// A continuous paired sensitivity check, independent of live ranking/gate.
export function evaluateCandidateSensitivity(manifest, results) {
 const lookup=new Map(results.map(r=>[r.unitId,r]));
 const specs={
  'tonal-gray': {key:'tonal',value:m=>m.range+m.localContrast,direction:1},
  'nonface-highlights': {key:'highlights',value:m=>m.fraction,direction:-1},
  'bg-separation': {key:'separation',value:m=>m.lumaDifference+m.colorDifference,direction:1},
 };
 const output={};
 for(const [category,spec] of Object.entries(specs)){
  const rows=manifest.pairs.filter(p=>p.degradation===category).map(p=>{
   const a=lookup.get(p.sourceId)?.candidateMeasurements?.[spec.key];
   const b=lookup.get(p.degradedId)?.candidateMeasurements?.[spec.key];
   const valid=a&&b&&Number.isFinite(spec.value(a))&&Number.isFinite(spec.value(b));
   const delta=valid?(spec.value(a)-spec.value(b))*spec.direction:null;
   return {id:p.id,sourceId:p.sourceId,strength:p.strength,source:a,degraded:b,policyEligible:Boolean(a?.eligible&&b?.eligible),delta,credit:delta===null?null:Math.abs(delta)<1e-8?.5:delta>0?1:0};
  });
  const summarize=list=>{const valid=list.filter(r=>r.credit!==null);return {pairs:list.length,covered:valid.length,na:list.length-valid.length,policyEligible:list.filter(r=>r.policyEligible).length,coverage:list.length?valid.length/list.length:null,accuracy:valid.length?valid.filter(r=>r.credit===1).length/valid.length:null,ties:valid.filter(r=>r.credit===.5).length,tieAdjustedAccuracy:valid.length?valid.reduce((s,r)=>s+r.credit,0)/valid.length:null};};
  output[category]={...summarize(rows),byStrength:Object.fromEntries(['mild','severe'].map(strength=>[strength,summarize(rows.filter(r=>r.strength===strength))])),rows};
 }
 return {purpose:'Controlled degradation sensitivity with reused source geometry; not aesthetic truth or a live ranking experiment',byDegradation:output};
}
export function compareSynthetic(previous, current, {allowExtended=false}={}) {
 const ids=new Map(current.rows.map(r=>[r.id??r.degradedId,r]));
 for(const old of previous.rows){
  const row=ids.get(old.id??old.degradedId);
  if(!row||['sourceId','degradedId','sha256','degradation','strength'].some(k=>row[k]!==old[k]))throw new Error('Comparison pair identity mismatch');
 }
 if(!allowExtended&&current.rows.length!==previous.rows.length)throw new Error('Comparison requires identical pairs');
 const oldIds=new Set(previous.rows.map(r=>r.id??r.degradedId));
 const matched=current.rows.filter(r=>oldIds.has(r.id??r.degradedId));
 const accuracy=matched.filter(r=>r.credit===1).length/matched.length;
 const mandatory=matched.filter(r=>r.expectedGate),gateRate=mandatory.filter(r=>r.gateRejected).length/mandatory.length;
 const categories=Object.fromEntries(Object.keys(previous.byDegradation).map(k=>{
  const rows=matched.filter(r=>r.degradation===k);
  return [k,{pairs:rows.length,accuracyDelta:rows.filter(r=>r.credit===1).length/rows.length-previous.byDegradation[k].accuracy}];
 }));
 return {matchedPairs:matched.length,additionalPairs:current.rows.length-matched.length,syntheticAccuracyDelta:accuracy-previous.accuracy,severeGateDelta:gateRate-previous.gate.rate,sourceFalseRejectDelta:current.sourceFalseReject.rate-previous.sourceFalseReject.rate,byDegradation:categories,unchangedRows:matched.every(r=>{const old=previous.rows.find(o=>(o.id??o.degradedId)===(r.id??r.degradedId));return r.credit===old.credit&&r.gateRejected===old.gateRejected&&r.sourceRejected===old.sourceRejected;})};
}
