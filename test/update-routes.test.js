import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateRouter } from '../src/server/update-routes.js';
import { createRunsRouter } from '../src/server/runs-routes.js';

async function request(updater, pathname, { method = 'POST', origin, contentType = 'application/json' } = {}) {
  let status, payload;
  const req = { method, headers: { 'content-type': contentType, ...(origin ? { origin } : {}) } };
  const res = { writeHead(value) { status = value; }, end(value) { payload = value ? JSON.parse(value) : null; } };
  await createUpdateRouter(updater)(req, res, new URL(`http://localhost${pathname}`));
  return { status, payload };
}

test('update HTTP routes reject remote origins and non-JSON, expose progress and dispatch rollback', async () => {
  const calls = [];
  const updater = { status: async () => ({ phase: 'download' }), apply: async options => { calls.push(options); } };
  assert.equal((await request(updater, '/update/apply', { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await request(updater, '/update/apply', { contentType: 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
  assert.equal((await request(updater, '/update/rollback', { origin: 'null' })).status, 202);
  assert.deepEqual(calls, [{ rollback: true }]);
  assert.equal((await request(updater, '/update/status', { method: 'GET' })).payload.phase, 'download');
  updater.updating = true;
  assert.equal((await request(updater, '/update/apply')).status, 409);
});

test('updates reject a new analysis before reading or writing a run', async () => {
  let code;
  const router = createRunsRouter({ isUpdating: () => true });
  await router({ method: 'POST' }, { writeHead(value) { code = value; }, end() {} }, new URL('http://localhost/runs'));
  assert.equal(code, 409);
});
