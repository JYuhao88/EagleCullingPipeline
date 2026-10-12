import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAnalysis, stageIndex, readRecentRuns, analysisProgress, durationText } from '../src/plugin/start-model.js';
import { serviceLaunch, serviceCommand, defaultRepository } from '../src/plugin/service-start.js';
import { eagleContext } from '../src/plugin/api.js';

test('primary analysis prioritizes selection, otherwise counts the folder and blocks empty context', () => {
  const context = { folders: [{ id: 'f' }], folderCount: 12, itemIds: ['a', 'b'] };
  assert.equal(primaryAnalysis(context).label, '分析选中的 2 张');
  assert.deepEqual(primaryAnalysis(context).itemIds, ['a', 'b']);
  assert.equal(primaryAnalysis({ ...context, itemIds: [] }).label, '分析当前文件夹（12 张）');
  assert.equal(primaryAnalysis({ ...context, itemIds: [] }).disabled, false);
  for (const value of [{}, { folders: [{}], folderCount: 0 }]) assert.equal(primaryAnalysis(value).disabled, true);
  assert.equal(primaryAnalysis(context, false).disabled, true);
  assert.equal(primaryAnalysis(context, true, true).disabled, true);
});

test('Windows launch uses node directly and PowerShell literal quoting; Unix retains nice', () => {
  const windows = serviceLaunch("C:\\Photo Repo's", 'http://localhost:43126', 'win32');
  assert.equal(windows.command, 'node');
  assert.deepEqual(windows.args, ['src/cli.js', 'serve', '--concurrency', '1', '--port', '43126']);
  assert.match(serviceCommand("C:\\Photo Repo's", 'http://localhost:43126', 'win32'), /Repo''s/);
  assert.doesNotMatch(serviceCommand('C:\\Repo', 'http://localhost:43126', 'win32'), /nice/);
  assert.equal(serviceLaunch('\\\\server\\share\\repo', 'http://localhost:43125', 'win32').command, 'node');
  assert.equal(serviceLaunch('//server/share/repo', 'http://localhost:43125', 'win32').command, 'node');
  assert.throws(() => serviceLaunch('C:relative', 'http://localhost', 'win32'), /绝对路径/);
  assert.equal(serviceLaunch('/tmp/example', 'http://localhost:43125', 'linux').command, 'nice');
  assert.deepEqual(serviceLaunch('/tmp/example', 'http://localhost:43125', 'darwin').args.slice(0, 3), ['-n', '15', 'node']);
  assert.equal(defaultRepository({ protocol: 'file:', pathname: '/C:/Repo/src/plugin/index.html' }), 'C:/Repo');
});

test('stage labels cover all analysis phases; malformed recent storage degrades safely', () => {
  assert.deepEqual(['scanning', 'pairing', 'metrics', 'embedding', 'faces', 'pose', 'focus', 'grouping', 'ranking', 'done']
    .map(stageIndex), [0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const value of ['{}', 'null', 'oops']) assert.deepEqual(readRecentRuns({ getItem: () => value }), []);
  assert.deepEqual(readRecentRuns({ getItem: () => '["run-ok","../bad",null]' }), ['run-ok']);
});

test('analysis progress displays measured overall estimates and distinct Chinese phases', () => {
  const run = { status: 'running', progress: { stage: 'focus', completed: 5, total: 10,
    overallPercent: 73.9, elapsedSeconds: 125, remainingSeconds: 65.1 } };
  const model = analysisProgress(run);
  assert.equal(model.overallPercent, 73.9);
  assert.equal(model.remainingSeconds, 66);
  assert.equal(model.text, '对焦分析 · 总体 73% · 已用 2 分 5 秒 · 预计剩余 1 分 6 秒');
  for (const [stage, label] of [['embedding', '特征提取'], ['pose', '姿态分析'], ['ranking', '排序']]) {
    assert.equal(analysisProgress({ ...run, progress: { ...run.progress, stage } }).stage, label);
  }
  assert.equal(durationText(3601), '1 小时 0 分');
  assert.equal(durationText(0), '0 秒');
});

test('old runs and insufficient warmup show estimating without inventing a percentage or ETA', () => {
  const startedAt = '2026-10-01T00:00:00Z', now = Date.parse(startedAt) + 90000;
  const legacy = { status: 'running', startedAt, progress: { stage: 'metrics', completed: 5, total: 10 } };
  const model = analysisProgress(legacy, now);
  assert.equal(model.overallPercent, null);
  assert.equal(model.remainingSeconds, null);
  assert.match(model.text, /总体进度待估算 · 已用 1 分 30 秒 · 预计剩余 估算中/);
  const warmup = analysisProgress({ ...legacy, progress: { ...legacy.progress, overallPercent: 12, remainingSeconds: null } });
  assert.match(warmup.text, /总体 12%/);
  assert.equal(warmup.remainingSeconds, null);
  assert.equal(analysisProgress({ status: 'completed', startedAt }, now).elapsedSeconds, null);
  assert.equal(analysisProgress({ status: 'completed', startedAt }, now).overallPercent, 100);
  assert.equal(analysisProgress({ status: 'interrupted', startedAt }, now).remainingSeconds, null);
});

test('invalid progress numbers degrade safely', () => {
  const model = analysisProgress({ status: 'running', progress: {
    overallPercent: NaN, elapsedSeconds: -1, remainingSeconds: Infinity
  } });
  assert.equal(model.overallPercent, null);
  assert.equal(model.elapsedSeconds, null);
  assert.equal(model.remainingSeconds, null);
  assert.match(model.text, /已用 未记录/);
});

test('Eagle context reads efficient counts and only loads folder items when starting analysis', async () => {
  const previous = globalThis.eagle;
  const queries = [];
  globalThis.eagle = {
    library: { path: '/example.library', name: '示例库' }, folder: { getSelected: async () => [{ id: 'f', name: '示例文件夹' }] },
    item: { getSelected: async () => [{ id: 'a' }], countAll: async () => 40,
      count: async query => { assert.deepEqual(query, { folders: ['f'] }); return 12; },
      get: async query => { queries.push(query); return [{ id: 'b' }]; } }
  };
  try {
    const context = await eagleContext();
    assert.equal(context.libraryCount, 40); assert.equal(context.folderCount, 12);
    assert.deepEqual(context.itemIds, ['a']); assert.deepEqual(queries, []);
    assert.deepEqual((await eagleContext({ selected: false })).itemIds, []);
    assert.deepEqual(queries, []);
    assert.deepEqual((await eagleContext({ includeFolderItems: true })).folderItemIds, ['b']);
    assert.deepEqual(queries, [{ folders: ['f'] }]);
  } finally { globalThis.eagle = previous; }
});
