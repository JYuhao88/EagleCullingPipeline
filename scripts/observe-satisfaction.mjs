#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunStore } from '../src/server/run-store.js';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { observationsFor } from '../src/core/observations.js';
import { groupMembersModel } from '../src/server/item-analysis.js';
import { contrastLines } from '../src/plugin/inspector/inspector-compare.js';

const KEPT = new Set(['selected', 'candidate']);
const ACTIONS = new Set([...KEPT, 'rejected']);
const newestFirst = (a, b) => (Date.parse(b.data.run.startedAt || b.data.run.createdAt) || 0)
  - (Date.parse(a.data.run.startedAt || a.data.run.createdAt) || 0)
  || String(b.data.run.id).localeCompare(String(a.data.run.id));
const ratio = (a, b) => b ? a / b : null;

export function proportion(hits, total) {
  if (!total) return { hits, total, rate: null, wilson95: null };
  const z2 = 1.959963984540054 ** 2, p = hits / total, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = Math.sqrt(p * (1 - p) / total + z2 / (4 * total ** 2)) * Math.sqrt(z2) / denominator;
  return { hits, total, rate: p, wilson95: { lower: hits ? Math.max(0, center - radius) : 0,
    upper: hits === total ? 1 : Math.min(1, center + radius) } };
}

function observationSummary(id, samples, pairs) {
  const kept = samples.filter(sample => sample.kept), rejected = samples.filter(sample => !sample.kept);
  const has = sample => sample.observations.some(observation => observation.id === id);
  const a = proportion(kept.filter(has).length, kept.length), b = proportion(rejected.filter(has).length, rejected.length);
  let keptOnly = 0, rejectedOnly = 0, both = 0, neither = 0;
  for (const [chosen, discarded] of pairs) {
    if (has(chosen) && has(discarded)) both++;
    else if (has(chosen)) keptOnly++;
    else if (has(discarded)) rejectedOnly++;
    else neither++;
  }
  const states = [...new Set(samples.flatMap(sample => sample.observations.filter(item => item.id === id).map(item => item.text)))].sort();
  return { id, kept: a, rejected: b,
    lift: { difference: a.rate === null || b.rate === null ? null : a.rate - b.rate,
      ratio: a.rate === null || b.rate === null ? null : ratio(a.rate, b.rate) },
    paired: { keptOnly, rejectedOnly, both, neither,
      keptShareAmongDiscordant: proportion(keptOnly, keptOnly + rejectedOnly) },
    states: states.map(text => {
      const shows = sample => sample.observations.some(item => item.id === id && item.text === text);
      return { text,
        kept: proportion(kept.filter(shows).length, kept.length),
        rejected: proportion(rejected.filter(shows).length, rejected.length) };
    }) };
}

export function satisfactionReport(snapshots = []) {
  const counts = { runs: snapshots.length, humanDecisions: 0, inheritedDecisions: 0, ignoredDecisions: 0,
    groups: 0, duplicateGroups: 0, tieGroups: 0, mixedGroups: 0, keptPhotos: 0, rejectedPhotos: 0,
    missingResults: 0, repeatedJudgedPhotos: 0, withinGroupKeptRejectedPairs: 0, pairsMissingResults: 0 };
  const pick = { hits: 0, total: 0, missingRecommendation: 0, undecidedRecommendation: 0, rejectedRecommendation: 0 };
  const contrast = { comparedPairs: 0, judgedPairs: 0, unjudgedPairs: 0, neutralLines: 0,
    directionalLines: 0, unjudgedDirectionalLines: 0, noDirectionalPairs: 0, conflictingPairs: 0,
    contributingGroups: 0, hits: 0, total: 0 };
  const samples = [], pairs = [], observationIds = new Set(), seenGroups = new Set(), seenPhotos = new Set();
  for (const { data, decisions = [] } of [...snapshots].sort(newestFirst)) {
    const human = new Map();
    for (const row of decisions) {
      if (row?.source !== 'human' || !ACTIONS.has(row.action)) { counts.ignoredDecisions++; continue; }
      human.set(row.unitId, row);
    }
    counts.humanDecisions += human.size;
    counts.inheritedDecisions += [...human.values()].filter(row => row.inheritedFrom).length;
    for (const result of data.results || []) for (const item of observationsFor(result)) observationIds.add(item.id);
    const results = new Set((data.results || []).map(row => row.unitId));
    const library = data.run.libraryPath || '';
    for (const group of data.groups || []) {
      counts.groups++;
      const ids = [...new Set(group.unitIds || [])];
      const key = JSON.stringify([library, [...ids].sort()]);
      if (seenGroups.has(key)) { counts.duplicateGroups++; continue; }
      seenGroups.add(key);
      if (ids.some(id => human.get(id)?.tie)) counts.tieGroups++;
      const kept = ids.filter(id => KEPT.has(human.get(id)?.action));
      const rejected = ids.filter(id => human.get(id)?.action === 'rejected');
      if (!kept.length || !rejected.length) continue;
      counts.mixedGroups++;
      counts.keptPhotos += kept.length; counts.rejectedPhotos += rejected.length;
      const members = groupMembersModel(data, group, decisions);
      const groupSamples = new Map();
      for (const member of members.filter(member => human.has(member.unitId))) {
        const photoKey = JSON.stringify([library, member.unitId]);
        if (seenPhotos.has(photoKey)) counts.repeatedJudgedPhotos++;
        seenPhotos.add(photoKey);
        if (!results.has(member.unitId)) { counts.missingResults++; continue; }
        const sample = { kept: KEPT.has(human.get(member.unitId).action), observations: member.observations || [] };
        samples.push(sample); groupSamples.set(member.unitId, sample);
        for (const observation of sample.observations) observationIds.add(observation.id);
      }
      for (const a of kept) for (const b of rejected) {
        counts.withinGroupKeptRejectedPairs++;
        if (!groupSamples.has(a) || !groupSamples.has(b)) { counts.pairsMissingResults++; continue; }
        pairs.push([groupSamples.get(a), groupSamples.get(b)]);
      }
      const top = (group.ranking || []).find(row => row.rank === 1 && ids.includes(row.unitId));
      if (!top) pick.missingRecommendation++;
      else if (!human.has(top.unitId)) pick.undecidedRecommendation++;
      else {
        pick.total++;
        if (KEPT.has(human.get(top.unitId).action)) pick.hits++;
        else pick.rejectedRecommendation++;
      }
      let contributed = false;
      // The lower-ranked view compares every non-top photo with the top exactly once, retaining the UI's line cap.
      for (const member of members.slice(1)) {
        contrast.comparedPairs++;
        const other = members[0];
        const currentAction = human.get(member.unitId)?.action, otherAction = human.get(other.unitId)?.action;
        const judged = ACTIONS.has(currentAction) && ACTIONS.has(otherAction)
          && KEPT.has(currentAction) !== KEPT.has(otherAction);
        contrast[judged ? 'judgedPairs' : 'unjudgedPairs']++;
        const lines = contrastLines(members, member.unitId);
        const directions = lines.filter(line => ['better', 'worse'].includes(line.tone));
        contrast.neutralLines += lines.length - directions.length;
        contrast.directionalLines += directions.length;
        if (!judged) { contrast.unjudgedDirectionalLines += directions.length; continue; }
        if (!directions.length) contrast.noDirectionalPairs++;
        if (new Set(directions.map(line => line.tone)).size > 1) contrast.conflictingPairs++;
        for (const line of directions) {
          contrast.total++;
          if (KEPT.has(line.tone === 'better' ? currentAction : otherAction)) contrast.hits++;
          contributed = true;
        }
      }
      if (contributed) contrast.contributingGroups++;
    }
  }
  return { version: 1,
    policy: { groundTruth: 'decisions.json: source=human only; Eagle tags ignored', kept: [...KEPT], rejected: 'rejected',
      eligibleGroups: 'at least one explicit kept and one explicit rejected; tied kept candidates still count as kept',
      deduplication: 'newest exact library+unit-id group membership; inherited decisions retained in that snapshot',
      recommendation: 'stored ranking rank=1; missing or undecided picks excluded and counted',
      observations: 'inspector display presence only; absence means not stated; text states reported separately',
      lift: 'kept statement rate minus rejected statement rate; ratio null when rejected rate is zero',
      contrast: 'each lower-ranked member vs top once, default 3 lines; neutral lines make no preference claim',
      intervals: 'Wilson 95% for binomial proportions; no Wilson interval for lift difference or ratio' },
    counts, recommendedPick: { ...proportion(pick.hits, pick.total), missingRecommendation: pick.missingRecommendation,
      undecidedRecommendation: pick.undecidedRecommendation, rejectedRecommendation: pick.rejectedRecommendation },
    observations: [...observationIds].sort().map(id => observationSummary(id, samples, pairs)),
    contrast: { ...contrast, agreement: proportion(contrast.hits, contrast.total) },
    caveats: ['Recorded choices are few and are not independent held-out labels or a satisfaction survey.',
      'Decisions may have accepted pipeline suggestions; agreement does not measure causal usefulness.',
      'Photos, pairs and lines within a burst are correlated; Wilson intervals are descriptive and can be optimistic.',
      'Exact duplicate groups are excluded; changed group memberships can still reuse judged photos (counted).',
      'Within selected snapshots the newest exact group shadows older choices, even if it is no longer mixed.',
      'Observation lift measures displayed statements, not attribute prevalence, precision or a shipping gate.',
      'Historical model observations are not recomputed; current rule and comparison code is applied to stored results.'] };
}

export async function loadSatisfaction({ root = 'data/runs', runIds = [] } = {}) {
  const store = new RunStore(root), runs = runIds.length
    ? await Promise.all(runIds.map(async id => {
      if (!/^run-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run id');
      const run = await store.getRun(id);
      if (!run) throw new Error('Requested run not found');
      return run;
    })) : await store.allRuns();
  const selection = { runsFound: runs.length, skippedSuperseded: 0, skippedIncomplete: 0, skippedPrefetch: 0,
    skippedNoHumanDecisions: 0, missingResults: 0, explicitlySelected: Boolean(runIds.length) };
  const snapshots = [];
  for (const run of runs) {
    if (run.purpose === 'prefetch') { selection.skippedPrefetch++; continue; }
    if (run.status !== 'completed') { selection.skippedIncomplete++; continue; }
    if (!runIds.length && run.supersededBy) { selection.skippedSuperseded++; continue; }
    const decisions = await new DecisionsStore(store.dir(run.id)).read();
    if (!decisions.some(row => row?.source === 'human' && ACTIONS.has(row.action))) {
      selection.skippedNoHumanDecisions++; continue;
    }
    const data = await store.get(run.id, { readOnly: true });
    if (!data) { selection.missingResults++; continue; }
    snapshots.push({ data, decisions });
  }
  return { selection, ...satisfactionReport(snapshots) };
}

async function main(args) {
  const options = { runIds: [] };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') {
      console.log('Usage: node scripts/observe-satisfaction.mjs [--root data/runs] [--run run-ID ...]'); return;
    }
    if (!['--root', '--run'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error('Usage: node scripts/observe-satisfaction.mjs [--root data/runs] [--run run-ID ...]');
    if (args[index] === '--root') options.root = args[++index];
    else options.runIds.push(args[++index]);
  }
  console.log(JSON.stringify(await loadSatisfaction(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(() => {
    console.error('Satisfaction report failed; check arguments and stored run JSON.');
    process.exitCode = 1;
  });
