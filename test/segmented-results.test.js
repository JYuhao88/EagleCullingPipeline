import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/server/run-store.js';
import { ResultsStore } from '../src/core/results-store.js';
import { Checkpoints } from '../src/core/checkpoints.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { createRunsRouter } from '../src/server/runs-routes.js';

function fixture() {
  const ids = ['a', 'b', 'c'];
  return { run: { id: 'one', status: 'completed' },
    units: ids.map(id => ({ id, primaryItemId: id, itemIds: [id] })),
    items: ids.map(id => ({ id, name: `合成-${id}` })),
    results: ids.map(unitId => ({ unitId, fingerprint: unitId, flags: [], metrics: { quality: null } })),
    groups: [{ id: 'g1', unitIds: ['a', 'b'], ranking: [], confidence: 'low' },
      { id: 'g2', unitIds: ['c'], ranking: [], confidence: 'single' }] };
}

test('segmented pages read offsets, preserve legacy reads and invalidate manifests across instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'segments-'));
  try {
    const writer = new RunStore(root), reader = new RunStore(root), data = fixture();
    await writer.save(data.run, data);
    await assert.rejects(readFile(path.join(writer.dir('one'), 'results.json')), { code: 'ENOENT' });
    // Prove hot-path pages never call the materializing compatibility reader.
    reader.results = () => { throw new Error('Full result load forbidden'); };
    const page = await reader.page('one', { limit: 1 });
    assert.equal(page.groups[0].id, 'g1');
    assert.equal(page.page.nextCursor, '1');
    assert.equal((await reader.page('one', { filter: 'multi' })).page.total, 1);
    assert.equal((await reader.page('one', { filter: 'confirm' })).page.total, 1);
    assert.deepEqual((await reader.unitData('one', 'c')).results, [data.results[2]]);
    data.results[2].fingerprint = 'changed';
    await writer.save(data.run, data);
    assert.equal((await reader.unitData('one', 'c')).results[0].fingerprint, 'changed');
    const route = createRunsRouter({ store: reader });
    let status;
    await route({ method: 'GET' }, { writeHead(code) { status = code; }, end() {} },
      new URL('http://localhost/runs/one/results?limit=10000'));
    assert.equal(status, 400);
    await mkdir(path.join(root, 'legacy'));
    await writeFile(path.join(root, 'legacy/run.json'), JSON.stringify({ id: 'legacy' }));
    await writeFile(path.join(root, 'legacy/results.json'), JSON.stringify(fixture()));
    const legacy = await writer.page('legacy', { groupId: 'g2' });
    assert.equal(legacy.results.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fingerprint cache isolates callers and ignores shared torn tails; private checkpoints repair tails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  try {
    let store = new ResultsStore(root);
    await store.put('a', { note: '中文', metrics: { quality: null } });
    await store.put('b', { note: '第二行' });
    const result = await store.get('a');
    result.note = 'changed';
    assert.equal((await store.get('a')).note, '中文');
    await appendFile(store.file, '{"fingerprint":');
    store = new ResultsStore(root);
    assert.equal((await store.get('b')).note, '第二行');
    await store.put('c', { note: '恢复' });
    assert.equal(await store.size(), 3);
    assert.equal((await new ResultsStore(root).get('c')).note, '恢复');
    assert.equal(await readFile(store.file, 'utf8'), '{"fingerprint":');
    const cpRoot = path.join(root, 'private');
    let checkpoint = new Checkpoints(cpRoot);
    await checkpoint.put('a', { note: '中文' });
    await appendFile(checkpoint.journal.file, '{"key":');
    checkpoint = new Checkpoints(cpRoot);
    assert.equal((await checkpoint.get('a')).note, '中文');
    await checkpoint.put('b', { note: '恢复' });
    assert.equal((await new Checkpoints(cpRoot).get('b')).note, '恢复');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pipeline resumes durable per-unit stages and completed grouping/ranking after cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-'));
  try {
    let analyzed = 0;
    const pipeline = new AnalysisPipeline({ root, cacheRoot: root, concurrency: 1,
      analyzer: async record => { analyzed++; return { metrics: {}, flags: [], phash: '0'.repeat(64),
        unitId: record.unitId, score: .5 }; }, faceDetector: async () => [], poseDetector: async () => [] });
    const records = ['a', 'b', 'c'].map((id, i) => ({ id, unitId: id, name: `synthetic-${i}`, exif: {},
      captureTime: new Date(i * 600000).toISOString(), sessionId: id, itemIds: [id] }));
    const controller = new AbortController();
    let checkpoint = new Checkpoints(root);
    await assert.rejects(pipeline.run(records, { checkpoint, signal: controller.signal, onProgress(progress) {
      if (progress.stage === 'metrics' && progress.completed === 2) controller.abort(new Error('stop metrics'));
    } }), /stop metrics/);
    assert.equal(analyzed, 2);
    checkpoint = new Checkpoints(root);
    const rankingController = new AbortController();
    const put = checkpoint.put.bind(checkpoint);
    checkpoint.put = async (key, value) => {
      await put(key, value);
      if (key.startsWith('ranking:')) rankingController.abort(new Error('stop ranking'));
    };
    await assert.rejects(pipeline.run(records, { checkpoint, signal: rankingController.signal }), /stop ranking/);
    assert.equal(analyzed, 3);
    const completed = await pipeline.run(records, { checkpoint: new Checkpoints(root) });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.results.length, 3);
    assert.equal(completed.groups.length, 3);
    assert.equal(completed.warnings.filter(warning => warning.includes('没有可用预览')).length, 3);
    assert.equal(analyzed, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reports stream through backpressure and page rows without materializing the run', async () => {
  const { Writable } = await import('node:stream');
  const { handleReviewRoute } = await import('../src/server/review-routes.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'report-stream-'));
  try {
    const store = new RunStore(root), data = fixture();
    for (const group of data.groups) group.ranking = group.unitIds.map((unitId, i) => ({ unitId, rank: i + 1 }));
    await store.save(data.run, data);
    store.get = () => { throw new Error('Full result load forbidden'); };
    async function request(query) {
      const chunks = [];
      const res = new Writable({ highWaterMark: 1, write(chunk, encoding, done) { chunks.push(chunk); setImmediate(done); } });
      res.writeHead = status => { res.status = status; };
      await handleReviewRoute({ method: 'GET', url: `/runs/one/report${query}` }, res, { runStore: store,
        json() { throw new Error('Streaming export expected'); } });
      if (!res.writableFinished) await new Promise(resolve => res.on('finish', resolve));
      assert.equal(res.status, 200);
      return Buffer.concat(chunks).toString('utf8');
    }
    assert.equal(JSON.parse(await request('?format=json')).length, 3);
    const page = JSON.parse(await request('?format=json&limit=1'));
    assert.equal(page.rows.length, 2);
    assert.equal(page.page.nextCursor, '1');
    const csv = await request('?format=csv&filter=singles');
    assert.equal(csv.trim().split('\n').length, 2);
    assert.match(csv, /合成-c/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP cancellation keeps a busy run owned until it stops and resumes persisted input after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resume-http-'));
  try {
    const store = new RunStore(root);
    const calls = [];
    const pipeline = { async run(records, { signal, checkpoint }) {
      calls.push(records.map(row => row.unitId));
      assert.ok(checkpoint);
      if (calls.length === 1) await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { status: 'completed', results: [], groups: [] };
    } };
    const active = { run: null };
    let route = createRunsRouter({ pipeline, store, active });
    async function request(method, pathname, body) {
      let status, result;
      const req = { method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body || {})); } };
      await route(req, { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } },
        new URL(pathname, 'http://localhost'));
      return { status, result };
    }
    const started = await request('POST', '/runs', { items: [{ id: 'a', name: 'synthetic', ext: 'jpg' }] });
    assert.equal(started.status, 202);
    const id = started.result.id;
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request('POST', `/runs/${id}/cancel`)).status, 200);
    while (active.run) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await store.getRun(id)).status, 'cancelled');
    route = createRunsRouter({ pipeline, store: new RunStore(root) });
    assert.equal((await request('POST', '/runs', { resumeRunId: id })).status, 202);
    while ((await store.getRun(id)).status !== 'completed') await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls[1], calls[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('learning ingestion of one page preserves group context for other pages', async () => {
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(os.tmpdir(), 'partial-learning-'));
  try {
    const store = new RunStore(root), data = fixture();
    await store.save(data.run, data);
    const key = createHash('sha256').update('one').digest('hex');
    const file = path.join(store.learningData.root, 'run-index/v1', `${key}-groups.json`);
    const before = JSON.parse(await readFile(file, 'utf8'));
    await store.learningData.ingestRun(await store.page('one', { limit: 1 }));
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(after.map(group => group.id), before.map(group => group.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});
