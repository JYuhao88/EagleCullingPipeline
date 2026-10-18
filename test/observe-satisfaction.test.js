import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSatisfaction, proportion, satisfactionReport } from '../scripts/observe-satisfaction.mjs';

const observation = (id, text, tone = 'neutral') => ({ id, text, tone, source: 'model', confidence: 0.99 });
const result = (unitId, items = [], eyeSharpness = 50) => ({ unitId, metrics: {},
  observations: { items }, focus: { eyeSharpnessNative: eyeSharpness } });
const decision = (unitId, action, extra = {}) => ({ unitId, action, source: 'human', ...extra });
function snapshot(rows, decisions, { id = 'run-test', groups, startedAt = '2026-01-01' } = {}) {
  const ids = rows.map(row => row.unitId);
  return { decisions, data: { run: { id, status: 'completed', startedAt, libraryPath: 'example.library' },
    units: ids.map(id => ({ id, itemIds: [id], primaryItemId: id })), results: rows,
    items: ids.map(id => ({ id, tags: ['精选', 'AI精选'], star: 5 })),
    groups: groups || [{ id: 'group', unitIds: ids,
      ranking: ids.map((unitId, index) => ({ unitId, rank: index + 1 })) }] } };
}

test('Wilson proportions retain empty denominators and finite boundary intervals', () => {
  assert.deepEqual(proportion(0, 0), { hits: 0, total: 0, rate: null, wilson95: null });
  assert.ok(Math.abs(proportion(90, 100).wilson95.lower - 0.8256343385) < 1e-9);
  assert.equal(proportion(0, 5).wilson95.lower, 0);
  assert.ok(proportion(5, 5).wilson95.lower < 1);
  assert.equal(proportion(5, 5).wilson95.upper, 1);
});

test('only explicit human kept/rejected choices qualify, regardless of tags or suggestions', () => {
  const data = snapshot([result('a'), result('b'), result('c')], [decision('a', 'candidate'),
    decision('b', 'rejected'), decision('c', 'selected', { source: 'suggested' })]);
  data.data.groups[0].suggested = { a: 'rejected', b: 'selected', c: 'selected' };
  const report = satisfactionReport([data]);
  assert.equal(report.counts.mixedGroups, 1);
  assert.equal(report.counts.humanDecisions, 2);
  assert.equal(report.counts.ignoredDecisions, 1);
  assert.equal(report.counts.keptPhotos, 1);
  assert.equal(report.counts.rejectedPhotos, 1);
  assert.equal(report.recommendedPick.hits, 1);
  assert.equal(report.recommendedPick.total, 1);
  assert.equal(satisfactionReport([snapshot([result('a'), result('b')], [])]).counts.mixedGroups, 0);
});

test('observation lift counts display presence, state texts, and within-group discordant pairs', () => {
  const report = satisfactionReport([snapshot([
    result('a', [observation('smile', '在笑', 'good'), observation('mouth', '嘴张开')]),
    result('b', [observation('smile', '没在笑')]), result('c'),
  ], [decision('a', 'selected'), decision('b', 'rejected'), decision('c', 'candidate')])]);
  const smile = report.observations.find(row => row.id === 'smile');
  assert.equal(smile.kept.hits, 1); assert.equal(smile.kept.total, 2);
  assert.equal(smile.rejected.hits, 1); assert.equal(smile.rejected.total, 1);
  assert.deepEqual(smile.lift, { difference: -0.5, ratio: 0.5 });
  assert.deepEqual([smile.paired.keptOnly, smile.paired.rejectedOnly, smile.paired.both, smile.paired.neither], [0, 1, 1, 0]);
  assert.equal(smile.states.find(row => row.text === '在笑').rejected.hits, 0);
  const mouth = report.observations.find(row => row.id === 'mouth');
  assert.equal(mouth.lift.difference, 0.5); assert.equal(mouth.lift.ratio, null);
  assert.equal(mouth.paired.keptShareAmongDiscordant.total, 1);
  assert.match(report.policy.observations, /absence means not stated/);
});

test('comparison agreement evaluates distinct top-vs-member edges and preserves three-line default', () => {
  const rows = [result('a', [], 100), result('b', [], 25), result('c', [], 50)];
  const report = satisfactionReport([snapshot(rows, [decision('a', 'selected'),
    decision('b', 'rejected'), decision('c', 'rejected')])]);
  assert.equal(report.contrast.comparedPairs, 2);
  assert.equal(report.contrast.judgedPairs, 2);
  assert.equal(report.contrast.agreement.total, 2);
  assert.equal(report.contrast.agreement.hits, 2);
  assert.equal(report.contrast.contributingGroups, 1);
  assert.match(report.policy.contrast, /default 3 lines/);
  const wrong = satisfactionReport([snapshot(rows.slice(0, 2), [decision('a', 'rejected'), decision('b', 'selected')])]);
  assert.equal(wrong.contrast.agreement.hits, 0);
  assert.equal(wrong.recommendedPick.rejectedRecommendation, 1);
});

test('neutral-only observation statements do not claim a better side', () => {
  const report = satisfactionReport([snapshot([result('a'), result('b', [observation('mouth', '嘴张开')])],
    [decision('a', 'selected'), decision('b', 'rejected')])]);
  assert.equal(report.contrast.neutralLines, 1);
  assert.equal(report.contrast.noDirectionalPairs, 1);
  assert.equal(report.contrast.agreement.rate, null);
});

test('inherited duplicate groups use newest snapshot and visibly report remaining repeated photos', () => {
  const old = snapshot([result('a'), result('b')], [decision('a', 'selected'), decision('b', 'rejected')]);
  const newer = snapshot([result('a'), result('b')], [decision('a', 'rejected', { inheritedFrom: 'run-old' }),
    decision('b', 'selected', { inheritedFrom: 'run-old' })], { id: 'run-new', startedAt: '2026-02-01' });
  const changed = snapshot([result('a'), result('c')], [decision('a', 'selected'), decision('c', 'rejected')],
    { id: 'run-changed' });
  const report = satisfactionReport([old, newer, changed]);
  assert.equal(report.counts.duplicateGroups, 1);
  assert.equal(report.counts.mixedGroups, 2);
  assert.equal(report.counts.inheritedDecisions, 2);
  assert.equal(report.counts.repeatedJudgedPhotos, 1);
  assert.equal(report.recommendedPick.hits, 1);
  assert.equal(report.recommendedPick.total, 2);
});

test('a newer exact group can shadow old mixed choices without merging historical decisions', () => {
  const old = snapshot([result('a'), result('b')], [decision('a', 'selected'), decision('b', 'rejected')]);
  const newer = snapshot([result('a'), result('b')], [decision('a', 'selected')],
    { id: 'run-new', startedAt: '2026-02-01' });
  const report = satisfactionReport([old, newer]);
  assert.equal(report.counts.duplicateGroups, 1);
  assert.equal(report.counts.mixedGroups, 0);
  assert.equal(report.recommendedPick.total, 0);
});

test('missing ranks, undecided leaders and missing results stay out of unsupported denominators', () => {
  const missing = snapshot([result('a'), result('b')], [decision('a', 'selected'), decision('b', 'rejected')]);
  missing.data.groups[0].ranking = [];
  const unknown = snapshot([result('c'), result('d'), result('e')], [decision('d', 'selected'), decision('e', 'rejected')]);
  unknown.data.results = unknown.data.results.filter(row => row.unitId !== 'e');
  const report = satisfactionReport([missing, unknown]);
  assert.equal(report.recommendedPick.missingRecommendation, 1);
  assert.equal(report.recommendedPick.undecidedRecommendation, 1);
  assert.equal(report.recommendedPick.total, 0);
  assert.equal(report.counts.missingResults, 1);
  assert.equal(report.counts.pairsMissingResults, 1);
  assert.equal(report.contrast.unjudgedPairs, 2);
});

test('tied kept candidates still express a preference over explicitly rejected photos', () => {
  const report = satisfactionReport([snapshot([result('a', [], 100), result('b', [], 100), result('c', [], 25)],
    [decision('a', 'candidate', { tie: true }), decision('b', 'candidate', { tie: true }), decision('c', 'rejected')])]);
  assert.equal(report.counts.tieGroups, 1);
  assert.equal(report.counts.mixedGroups, 1);
  assert.equal(report.counts.withinGroupKeptRejectedPairs, 2);
  assert.equal(report.recommendedPick.hits, 1);
  assert.equal(report.contrast.agreement.hits, 1);
});

test('ids absent from all eligible choices still have zero statement counts and intervals', () => {
  const value = snapshot([result('a'), result('b'), result('c', [observation('smile', '在笑')])],
    [decision('a', 'selected'), decision('b', 'rejected')], { groups: [
      { id: 'mixed', unitIds: ['a', 'b'], ranking: [{ unitId: 'a', rank: 1 }, { unitId: 'b', rank: 2 }] },
      { id: 'unjudged', unitIds: ['c'] }] });
  const smile = satisfactionReport([value]).observations.find(row => row.id === 'smile');
  assert.equal(smile.kept.hits, 0); assert.equal(smile.kept.total, 1);
  assert.equal(smile.rejected.hits, 0); assert.equal(smile.rejected.total, 1);
  assert.equal(smile.kept.wilson95.lower, 0);
  assert.equal(smile.lift.ratio, null);
});

test('metric follows stored ranks and exactly the first three displayed lines', () => {
  const value = snapshot([result('a', [observation('smile', '在笑', 'good')], 25), result('b', [], 100)],
    [decision('a', 'rejected'), decision('b', 'selected')]);
  value.data.results[0].verdicts = [{ ruleId: 'G-PROXY-BLUR', verdict: 'warn' }];
  value.data.results[1].verdicts = [{ ruleId: 'G-PROXY-BLUR', verdict: 'pass' }];
  value.data.results[1].metrics = { raw: {} };
  value.data.results[0].focus.afSource = 'FocusLocation';
  value.data.results[0].focus.afPoint = [0.5, 0.5];
  value.data.results[0].focus.afPointOnEye = true;
  value.data.results[1].focus.afSource = 'FocusLocation';
  value.data.results[1].focus.afPoint = [0.5, 0.5];
  value.data.results[1].focus.afPointOnEye = false;
  value.data.groups[0].unitIds.reverse();
  const report = satisfactionReport([value]);
  assert.equal(report.recommendedPick.rejectedRecommendation, 1);
  // Blur, eye sharpness, then AF location are shown; the smile statement is the fourth candidate line.
  assert.equal(report.contrast.agreement.total, 2);
  assert.equal(report.contrast.agreement.hits, 2);
  assert.equal(report.contrast.neutralLines, 1);
});

test('run stores are read without writes and default selection excludes superseded/incomplete snapshots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observe-satisfaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, extra] of [['run-active', {}], ['run-old', { supersededBy: 'run-active' }],
    ['run-partial', { status: 'running' }], ['run-prefetch', { purpose: 'prefetch' }]]) {
    const value = snapshot([result('a'), result('b')], [decision('a', 'selected'), decision('b', 'rejected')], { id });
    value.data.run = { ...value.data.run, ...extra };
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'run.json'), JSON.stringify(value.data.run));
    await writeFile(path.join(root, id, 'results.json'), JSON.stringify(value.data));
    await writeFile(path.join(root, id, 'decisions.json'), JSON.stringify(value.decisions));
  }
  const filesBefore = await readdir(root, { recursive: true });
  const before = await readFile(path.join(root, 'run-active', 'decisions.json'), 'utf8');
  const report = await loadSatisfaction({ root });
  assert.equal(report.counts.runs, 1);
  assert.equal(report.selection.skippedSuperseded, 1);
  assert.equal(report.selection.skippedIncomplete, 1);
  assert.equal(report.selection.skippedPrefetch, 1);
  assert.equal(report.recommendedPick.hits, 1);
  assert.deepEqual(await readdir(root, { recursive: true }), filesBefore);
  assert.equal(await readFile(path.join(root, 'run-active', 'decisions.json'), 'utf8'), before);
  const explicit = await loadSatisfaction({ root, runIds: ['run-old', 'run-active'] });
  assert.equal(explicit.counts.duplicateGroups, 1);
  await assert.rejects(loadSatisfaction({ root, runIds: ['../elsewhere'] }), /Invalid run id/);
});
