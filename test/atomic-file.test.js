import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceFile } from '../src/core/atomic-file.js';

test('Windows atomic replacement retries sharing violations then succeeds', async () => {
  const delays = [], calls = [];
  await replaceFile('temporary', 'destination', { platform: 'win32', wait: async delay => delays.push(delay),
    renameFile: async (...args) => {
      calls.push(args);
      if (calls.length <= 3) throw Object.assign(new Error('Sharing violation'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls.length - 1] });
    } });
  assert.deepEqual(delays, [50, 100, 200]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(args => args[0] === 'temporary' && args[1] === 'destination'));
});

test('persistent Windows sharing violation preserves the final error after ten attempts', async () => {
  let attempts = 0; const delays = [], error = Object.assign(new Error('Locked'), { code: 'EPERM' });
  await assert.rejects(replaceFile('temporary', 'destination', { platform: 'win32',
    renameFile: async () => { attempts++; throw error; }, wait: async delay => delays.push(delay) }), e => e === error);
  assert.equal(attempts, 10);
  assert.deepEqual(delays, [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000]);
});

test('POSIX and nontransient Windows errors fail immediately', async () => {
  for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EBUSY'], ['win32', 'ENOENT']]) {
    let attempts = 0, waits = 0;
    await assert.rejects(replaceFile('temporary', 'destination', { platform,
      renameFile: async () => { attempts++; throw Object.assign(new Error(code), { code }); },
      wait: async () => { waits++; } }), { code });
    assert.equal(attempts, 1); assert.equal(waits, 0);
  }
});
