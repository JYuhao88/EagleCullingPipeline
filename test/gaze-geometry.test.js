import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GazeGeometryBridge, gazeGeometryVector } from '../src/core/gaze-geometry.js';

const sha = 'a'.repeat(64), vector = Array.from({ length: 228 }, (_, i) => i / 100);
const python = code => {
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
let pythonResults;
const checked = name => {
  pythonResults ??= JSON.parse(python(`
import hashlib, json, tempfile, traceback
from pathlib import Path
import numpy as np
from ml.observe.gaze_geometry import EYES, geometry_features, geometry_terms_vector, pose_from_matrix
from python_worker.gaze_worker import GazeWorker
results = {}
def check(function):
    try: results[function.__name__] = {'value': function()}
    except Exception: results[function.__name__] = {'error': traceback.format_exc()}

@check
def terms():
    raw = np.linspace(-.9, .9, 19, dtype=np.float32)
    actual = geometry_terms_vector(raw)
    assert actual.dtype == np.float64 and actual.shape == (228,)
    for invalid in [np.zeros(18), np.zeros((1,19)), [float('nan')] * 19, [1e300] * 19]:
        try:
            geometry_terms_vector(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid vector accepted')
    return {'raw':raw.tolist(), 'terms':actual.tolist()}

@check
def worker():
    created, closed = [], []
    class Fake:
        def __init__(self, path): self.path=path; created.append(path)
        def close(self): closed.append(self.path)
        def extract(self, path):
            return None if path == 'missing' else np.arange(19, dtype=np.float32) / 100
    with tempfile.TemporaryDirectory(prefix='gaze-worker-test-') as folder:
        first, second = Path(folder).resolve() / 'first.task', Path(folder).resolve() / 'second.task'
        first.write_bytes(b'first'); second.write_bytes(b'second')
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        worker = GazeWorker(Fake, lambda path: (384,384) if path != 'wrong-size' else (383,384))
        record = {'id':1, 'filePath':'face', 'modelPath':str(first), 'modelSha256':sha(first)}
        a, b = worker.handle(record), worker.handle({**record, 'id':2})
        assert a['available'] and len(a['features']) == 228 and len(created) == 1
        assert a['features'] == b['features'] and a['modelSha256'] == sha(first)
        assert worker.handle({**record, 'filePath':'missing'})['features'] is None
        for invalid in [{**record, 'filePath':'wrong-size'}, {**record, 'modelSha256':'b'*64}]:
            try: worker.handle(invalid)
            except ValueError: pass
            else: raise AssertionError('invalid input accepted')
        assert closed == [first]
        worker.handle({**record, 'modelPath':str(second), 'modelSha256':sha(second)})
        assert created == [first, second]
        worker.close()
        assert closed == [first, second]

@check
def iris():
    points = [{'x': .5, 'y': .5, 'z': 0} for _ in range(478)]
    for index, (corners, iris, uppers, lowers) in enumerate(EYES):
        center = .3 + .4 * index
        points[corners[0]] = {'x': center - .1, 'y': .4, 'z': 0}
        points[corners[1]] = {'x': center + .1, 'y': .4, 'z': 0}
        for i, (dx, dy) in zip(iris, [(0, 0), (.025, 0), (0, .025), (-.025, 0), (0, -.025)]):
            points[i] = {'x': center + dx, 'y': .4 + dy, 'z': 0}
        for i in uppers: points[i] = {'x': center, 'y': .37, 'z': 0}
        for i in lowers: points[i] = {'x': center, 'y': .43, 'z': 0}
    result = geometry_features(points, np.eye(4))
    assert result['poseAvailable'] and len(result['features']) == 19
    assert np.isfinite(result['features']).all()
    assert max(abs(x) for x in result['irisX']) < 1e-12
    expanded = geometry_terms_vector(result['features'])
    assert len(expanded) == 228 and np.isfinite(expanded).all()
    assert geometry_features(points[:477], np.eye(4)) is None
    assert pose_from_matrix(np.zeros((4, 4))) is None
    points[133] = points[33]
    assert geometry_features(points, np.eye(4)) is None

print(json.dumps(results))
`));
  const result = pythonResults[name];
  assert.equal(result.error, undefined, result.error);
  return result.value;
};

function fakeSpawn(answer = record => ({ id: record.id, available: true, modelSha256: sha, features: vector })) {
  const children = [], records = [];
  const spawnWorker = () => {
    const child = new EventEmitter();
    children.push(child);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.ref = child.unref = () => {};
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setImmediate(() => child.emit('close', 0));
    };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).trim().split('\n')) {
        const record = JSON.parse(line);
        records.push(record);
        const result = answer(record, child);
        if (result !== undefined) setImmediate(() => child.stdout.write(JSON.stringify(result) + '\n'));
      }
      done();
    } });
    return child;
  };
  return { spawnWorker, children, records };
}

test('geometry expansion matches frozen float64 ordering and rejects invalid products', () => {
  const result = checked('terms');
  const expected = [...result.raw, ...result.raw.map(Math.abs)];
  for (let i = 0; i < 19; i++) for (let j = i; j < 19; j++) expected.push(result.raw[i] * result.raw[j]);
  assert.deepEqual(result.terms, expected);
});

test('Python worker reuses verified models, closes replacements and requires exact crops', () => {
  checked('worker');
});

test('iris geometry requires both valid eyes and a nondegenerate head transform', () => {
  checked('iris');
});

test('gaze bridge serializes requests and reuses one worker with explicit SHA', async () => {
  const fake = fakeSpawn(), bridge = new GazeGeometryBridge({ ...fake, idleMs: 5 });
  try {
    const results = await Promise.all(['one.png', 'two.png', 'three.png']
      .map(file => bridge.vector(file, 'face.task', { modelSha256: sha })));
    assert.deepEqual(results, [vector, vector, vector]);
    assert.equal(fake.children.length, 1);
    assert.deepEqual(fake.records.map(record => record.id), [1, 2, 3]);
    assert.ok(fake.records.every(record => record.modelSha256 === sha));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(fake.children[0].killed, true);
  } finally { bridge.close(); }
});

test('gaze bridge abstains on worker errors, malformed dimensions and checksum mismatch', async () => {
  const responses = [
    { available: false, error: { code: 'inference_error' } },
    { available: true, modelSha256: sha, features: Array(227).fill(0) },
    { available: true, modelSha256: 'b'.repeat(64), features: vector },
    { available: true, modelSha256: sha, features: Array(228).fill(null) },
  ];
  const fake = fakeSpawn(record => ({ id: record.id, ...responses.shift() }));
  const bridge = new GazeGeometryBridge(fake);
  try {
    for (let i = 0; i < 4; i++) assert.equal(await bridge.vector('face.png', 'face.task', { modelSha256: sha }), null);
  } finally { bridge.close(); }
});

test('gaze bridge propagates active/queued cancellation and restarts after active abort', async () => {
  const fake = fakeSpawn(record => record.filePath.endsWith('slow.png') ? undefined
    : ({ id: record.id, available: true, modelSha256: sha, features: vector }));
  const bridge = new GazeGeometryBridge(fake), active = new AbortController(), queued = new AbortController();
  try {
    const first = bridge.vector('slow.png', 'face.task', { modelSha256: sha }, active.signal);
    const second = bridge.vector('queued.png', 'face.task', { modelSha256: sha }, queued.signal);
    const firstRejected = assert.rejects(first, /active stopped/), secondRejected = assert.rejects(second, /queued stopped/);
    queued.abort(new Error('queued stopped'));
    active.abort(new Error('active stopped'));
    await Promise.all([firstRejected, secondRejected]);
    assert.deepEqual(await bridge.vector('next.png', 'face.task', { modelSha256: sha }), vector);
    assert.equal(fake.children.length, 2);
    assert.equal(fake.children[0].killed, true);
    assert.equal(fake.records.length, 2);
    const early = new AbortController(); early.abort(new Error('before spawn'));
    await assert.rejects(gazeGeometryVector('face.png', 'face.task', {}, early.signal), /before spawn/);
  } finally { bridge.close(); }
});

test('gaze bridge timeouts and closed bridges settle without keeping pending jobs', async () => {
  const fake = fakeSpawn(() => undefined), bridge = new GazeGeometryBridge({ ...fake, timeoutMs: 5 });
  assert.equal(await bridge.vector('face.png', 'face.task', { modelSha256: sha }), null);
  assert.equal(fake.children[0].killed, true);
  bridge.close();
  assert.equal(await bridge.vector('face.png', 'face.task', { modelSha256: sha }), null);
});

test('an idle bridge releases process handles and its fake child finishes at stdin EOF', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gaze-bridge-'));
  try {
    const script = path.join(folder, 'fake-worker.mjs');
    await writeFile(script, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const row=JSON.parse(line); console.log(JSON.stringify({id:row.id,available:true,features:Array(228).fill(0)}));
});\n`);
    const module = new URL('../src/core/gaze-geometry.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import {GazeGeometryBridge} from ${JSON.stringify(module)};
const bridge = new GazeGeometryBridge({python:process.execPath,script:${JSON.stringify(script)}});
const vector = await bridge.vector('face.png','model.task');
console.log(vector.length);
`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '228');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
