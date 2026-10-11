import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { restartService } from '../src/server/update-restart.js';

async function listener(t) {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, old: true })));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('sandbox blocks loopback listen'); return null; }
    throw error;
  }
  const port = server.address().port;
  const instance = { server, listen: () => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { instance, port };
}

test('real candidate health failure keeps old service listening', async t => {
  const setup = await listener(t); if (!setup) return;
  const cwd = await mkdtemp(path.join(tmpdir(), 'update-restart-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entry = path.join(cwd, 'candidate.cjs');
  await writeFile(entry, `const http = require('node:http');
const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: false })));
server.listen(0, '127.0.0.1', () => process.send({ type: 'update-ready', port: server.address().port }));`);
  const restart = restartService(setup.instance, { ...setup, cwd, entry, args: [], execArgs: [], exit: () => {} });
  await assert.rejects(restart({ logFile: path.join(cwd, 'update.log') }), /健康检查/);
  assert.equal((await (await fetch(`http://127.0.0.1:${setup.port}/health`)).json()).old, true);
});

test('real candidate promotes on the original port after isolated health check', async t => {
  const setup = await listener(t); if (!setup) return;
  const cwd = await mkdtemp(path.join(tmpdir(), 'update-promote-'));
  const entry = path.join(cwd, 'candidate.mjs');
  const module = new URL('../src/server/update-restart.js', import.meta.url).href;
  await writeFile(entry, `import http from 'node:http';
import { candidateService } from ${JSON.stringify(module)};
const server = http.createServer((req, res) => {
  res.end(JSON.stringify({ ok: true, updateToken: process.env.EAGLE_UPDATE_CANDIDATE }));
  if (req.url === '/test-stop') {
    server.close(() => process.exit(0)); server.closeAllConnections();
  }
});
setTimeout(() => process.exit(0), 10000).unref();
await candidateService({ server, close: () => new Promise(resolve => server.close(resolve)) });`);
  let exited = false;
  const restart = restartService(setup.instance, { ...setup, cwd, entry, args: [], execArgs: [], exit: () => { exited = true; } });
  t.after(async () => {
    try {
      await fetch(`http://127.0.0.1:${setup.port}/test-stop`, { signal: AbortSignal.timeout(3000) });
    } catch { /* The fixture can close its socket before fetch resolves; it also has a bounded lifetime. */ }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const handoff = await restart({ logFile: path.join(cwd, 'update.log') });
  const value = await (await fetch(`http://127.0.0.1:${setup.port}/health`)).json();
  assert.equal(value.ok, true);
  assert.ok(value.updateToken);
  assert.equal(exited, false);
  handoff.finish();
});
