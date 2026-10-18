import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadOnlyEagleProxy, isReadOnlyEagleRequest } from '../scripts/eagle-readonly-proxy.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

async function startProxy(t, handler, options) {
  const upstream = http.createServer(handler);
  await listen(upstream);
  const proxy = createReadOnlyEagleProxy(`http://127.0.0.1:${upstream.address().port}`, options);
  await listen(proxy.server);
  t.after(async () => { await close(proxy.server); await close(upstream); });
  return { proxy, base: `http://127.0.0.1:${proxy.server.address().port}` };
}

test('Eagle proxy allowlist blocks writes, unknown GET and case/path tricks', () => {
  for (const p of ['/api/library/info', '/api/v2/item/list', '/api/folder/list']) assert.equal(isReadOnlyEagleRequest('GET', p), true);
  for (const p of ['/api/item/update', '/api/library/switch', '/api/item/list/', '/api/item/%6cist'])
    assert.equal(isReadOnlyEagleRequest('GET', p), false);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal(isReadOnlyEagleRequest(method, '/api/item/list'), false);
});

test('actual proxy rejects a write without reaching upstream and counts every request', async t => {
  const reached = [];
  const { proxy, base } = await startProxy(t, (req, res) => { reached.push(req.method); res.end('{}'); });
  assert.equal((await fetch(base + '/api/item/update', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(base + '/api/library/switch', { method: 'POST', body: '{"libraryPath":"safe.library"}' })).status, 405);
  assert.equal((await fetch(base + '/api/item/list')).status, 200);
  assert.deepEqual(reached, ['GET']);
  assert.deepEqual(proxy.summary(), { 'POST /api/item/update': 1, 'POST /api/library/switch': 1, 'GET /api/item/list': 1 });
  assert.equal(proxy.requests[0].allowed, false);
});

test('proxy permits only explicitly listed library switches and logs a target hash', async t => {
  const reached = [];
  const { proxy, base } = await startProxy(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    reached.push({ method: req.method, path: req.url, body: JSON.parse(body) }); res.end('{}');
  }, { switchLibraries: ['safe.library', '未删减.library'] });
  for (const body of [{ libraryPath: 'unknown.library' }, { libraryPath: '未删减.library' },
    { libraryPath: 'safe.library', extra: true }, { libraryPath: null }]) {
    assert.equal((await fetch(base + '/api/library/switch', { method: 'POST', body: JSON.stringify(body) })).status, 405);
  }
  assert.equal((await fetch(base + '/api/item/update', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(base + '/api/library/switch',
    { method: 'POST', body: JSON.stringify({ libraryPath: 'safe.library' }) })).status, 200);
  assert.deepEqual(reached, [{ method: 'POST', path: '/api/library/switch', body: { libraryPath: 'safe.library' } }]);
  const entry = proxy.requests.at(-1);
  assert.equal(entry.kind, 'library-switch'); assert.match(entry.targetHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(entry).includes('safe.library'), false);
});

test('proxy fails closed when its durable request audit cannot be written', async t => {
  let reached = false;
  const { proxy, base } = await startProxy(t, (req, res) => { reached = true; res.end('{}'); },
    { auditRequest: async () => { throw new Error('Disk unavailable'); } });
  assert.equal((await fetch(`${base}/api/library/info`)).status, 503);
  assert.equal(reached, false); assert.equal(proxy.requests[0].allowed, false);
});
