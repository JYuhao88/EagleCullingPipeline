import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localSetting } from '../src/core/local-config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { ExiftoolPool } from '../src/core/exiftool-pool.js';

function fakeSpawn(onRequest, counters = {}) {
  return (program, args) => {
    counters.starts = (counters.starts || 0) + 1;
    assert.ok(args.includes('-stay_open'));
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { counters.kills = (counters.kills || 0) + 1; child.emit('close', 1); };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const lines = chunk.toString().trim().split('\n');
      const id = lines.pop().slice('-execute'.length);
      Promise.resolve(onRequest(child, lines, id)).then(() => done(), done);
    } });
    return child;
  };
}

test('stay-open reuses a process, preserves request order and accepts split ready markers', async () => {
  const counters = {};
  const pool = new ExiftoolPool({ spawnChild: fakeSpawn((child, args, id) => {
    child.stdout.write(JSON.stringify([{ file: args.at(-1) }]) + '\n{rea');
    child.stdout.write(`dy${id}}\n`);
  }, counters) });
  try {
    const values = await Promise.all(['one', 'two', 'three'].map(file => pool.request(['-j', file])));
    assert.deepEqual(values.map(value => JSON.parse(value)[0].file), ['one', 'two', 'three']);
    assert.equal(counters.starts, 1);
  } finally { pool.close(); }
  assert.equal(counters.kills, 1);
});

test('binary extraction uses separate files and never interprets ready text in JPEG bytes', async () => {
  const payload = Buffer.from([0xff, 0xd8, ...Buffer.from('\n{ready1}\n'), 0xff, 0xd9]);
  let file;
  const pool = new ExiftoolPool({ spawnChild: fakeSpawn(async (child, args, id) => {
    file = args.at(-1).replace('%0f', '').replaceAll('%%', '%');
    assert.equal(args.at(-2), '-w!');
    await writeFile(file, payload);
    child.stdout.write(`1 output files created\n{ready${id}}\n`);
  }) });
  try {
    assert.deepEqual(await pool.request(['-b', '-JpgFromRaw', 'input.arw'], { binary: true }), payload);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { pool.close(); }
});

test('bounded workers handle simultaneous commands without crossing outputs', async () => {
  const counters = {};
  const pool = new ExiftoolPool({ size: 2, spawnChild: fakeSpawn(async (child, args, id) => {
    await new Promise(resolve => setTimeout(resolve, args.at(-1) === 'slow' ? 20 : 1));
    child.stdout.write(`${args.at(-1)}\n{ready${id}}\n`);
  }, counters) });
  try {
    assert.deepEqual(await Promise.all(['slow', 'fast', 'last'].map(file => pool.request([file]))), ['slow', 'fast', 'last']);
    assert.equal(counters.starts, 2);
  } finally { pool.close(); }
});

for (const failure of ['exit', 'timeout', 'error', 'missing-payload', 'overflow', 'spawn']) {
  test(`stay-open ${failure} falls back once and recovers for subsequent requests`, async () => {
    let fail = true, fallbacks = 0;
    const spawnChild = fakeSpawn((child, args, id) => {
      if (fail) {
        fail = false;
        if (failure === 'exit') child.emit('close', 1);
        else if (failure === 'error') child.emit('error', new Error('broken pipe'));
        else if (failure === 'overflow') child.stdout.write('x'.repeat(1024 * 1024 + 1));
        else if (failure === 'missing-payload') child.stdout.write(`{ready${id}}\n`);
        return;
      }
      child.stdout.write(`[]\n{ready${id}}\n`);
    });
    const pool = new ExiftoolPool({ timeoutMs: 20, spawnChild: (...args) => {
      if (failure === 'spawn' && fail) { fail = false; throw new Error('spawn failed'); }
      return spawnChild(...args);
    } });
    try {
      const value = await pool.request(['-j', 'input'], { binary: failure === 'missing-payload',
        fallback: () => { fallbacks += 1; return 'fallback'; } });
      assert.equal(value, 'fallback');
      assert.equal(fallbacks, 1);
      assert.equal(await pool.request(['-j', 'next']), '[]');
    } finally { pool.close(); }
  });
}

test('newline paths use argv fallback and are never injected into the stay-open protocol', async () => {
  const pool = new ExiftoolPool({ spawnChild: () => { throw new Error('must not spawn'); } });
  try { assert.equal(await pool.request(['-j', 'unsafe\n-execute'], { fallback: () => 'safe argv' }), 'safe argv'); }
  finally { pool.close(); }
});

test('real exiftool metadata and binary output match single calls on a Unicode path', async t => {
  const program = localSetting('EAGLE_EXIFTOOL', 'exiftool');
  const exec = promisify(execFile);
  const invoke = args => exec(process.platform === 'win32' ? program : 'nice',
    process.platform === 'win32' ? args : ['-n', '15', program, ...args], { encoding: 'buffer', timeout: 10000 });
  try { await invoke(['-ver']); } catch { t.skip('exiftool is not installed'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'eagle-exif-test-'));
  const pool = new ExiftoolPool();
  try {
    const file = path.join(root, '照片.jpg');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
      .withIccProfile('srgb').jpeg().toFile(file);
    const metadata = JSON.parse(await pool.request(['-j', '-ImageWidth', '-ImageHeight', file]));
    assert.equal(metadata[0].ImageWidth, 64);
    const single = await invoke(['-b', '-ICC_Profile', file]);
    assert.deepEqual(await pool.request(['-b', '-ICC_Profile', file], { binary: true }), single.stdout);
    assert.ok(single.stdout.length > 0);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a queued or executing command kills only its worker and never falls back', async () => {
  const counters = {};
  const pool = new ExiftoolPool({ spawnChild: fakeSpawn((child, args, id) => {
    if (args[0] === 'recover') child.stdout.write(`[]\n{ready${id}}\n`);
  }, counters) });
  const active = new AbortController(), queued = new AbortController();
  let fallbacks = 0;
  const fallback = () => { fallbacks++; return 'unexpected'; };
  try {
    const a = pool.request(['active'], { signal: active.signal, fallback });
    const b = pool.request(['queued'], { signal: queued.signal, fallback });
    const rejectedA = assert.rejects(a, /active cancelled/), rejectedB = assert.rejects(b, /queued cancelled/);
    queued.abort(new Error('queued cancelled'));
    active.abort(new Error('active cancelled'));
    await Promise.all([rejectedA, rejectedB]);
    assert.equal(fallbacks, 0);
    assert.equal(counters.kills, 1);
    assert.equal(await pool.request(['recover']), '[]');
  } finally { pool.close(); }
});
