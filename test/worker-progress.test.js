import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { FaceWorkerPool } from '../src/core/faces.js';

function fakeSpawn({ hold = new Set() } = {}) {
  return () => {
    const child = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const { id } = JSON.parse(line);
        if (!hold.has(id)) setImmediate(() => child.stdout.write(`${JSON.stringify({ id, faces: 0 })}\n`));
      }
      done();
    }, final(done) { setImmediate(() => child.emit('close', 0)); done(); } });
    return child;
  };
}

test('worker pool reports each finished photo as it completes', async () => {
  const pool = new FaceWorkerPool({ size: 2, spawnWorker: fakeSpawn(), idleMs: 10 });
  const seen = [];
  const results = await pool.run(['a', 'b', 'c'].map(id => ({ id })), { onItem: result => seen.push(result.id) });
  pool.close();
  assert.deepEqual(results.map(result => result.id), ['a', 'b', 'c']);
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('cancelled photos never report progress, and a throwing progress callback cannot fail inference', async () => {
  const pool = new FaceWorkerPool({ size: 1, spawnWorker: fakeSpawn({ hold: new Set(['slow']) }), idleMs: 10 });
  const controller = new AbortController();
  const seen = [];
  const pending = pool.run([{ id: 'slow' }, { id: 'queued' }], { signal: controller.signal, onItem: result => seen.push(result.id) });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  assert.deepEqual(seen, []);
  pool.close();
  const next = new FaceWorkerPool({ size: 1, spawnWorker: fakeSpawn(), idleMs: 10 });
  const results = await next.run([{ id: 'x' }], { onItem() { throw new Error('ui'); } });
  next.close();
  assert.equal(results[0].id, 'x');
});
