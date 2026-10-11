import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionsStore } from '../src/core/decisions-store.js';
import { completeEyeRois } from '../src/core/eye-roi.js';
import { focusRegionBox } from '../src/server/focus-image.js';
import { keyboardAction } from '../src/plugin/keyboard.js';
import { buildReport, reportCsv } from '../src/core/report.js';
import { isReadOnlyEagleRequest } from '../scripts/eagle-readonly-proxy.mjs';
function person() {
  const points = Array.from({ length: 133 }, (_, i) => [.35 + (i%8)*.01, .2 + Math.floor(i%68/8)*.01, .95]);
  for (let i=0;i<12;i++) points[59+i] = [.39 + (i>=6 ? .06 : 0) + (i%6)*.002, .23+(i%2)*.005, .95];
  return { box: [.1,.1,.9,.9], score:.9, keypoints:{points} };
}
test('Eagle proxy allowlist blocks writes, unknown GET and case/path tricks', () => {
  for (const p of ['/api/library/info','/api/v2/item/list','/api/folder/list']) assert.equal(isReadOnlyEagleRequest('GET', p), true);
  for (const p of ['/api/item/update','/api/library/switch','/api/item/list/','/api/item/%6cist'])
    assert.equal(isReadOnlyEagleRequest('GET', p), false);
  for (const method of ['POST','PUT','DELETE','HEAD']) assert.equal(isReadOnlyEagleRequest(method,'/api/item/list'), false);
});
test('free reason roundtrip, batch rejection is atomic, keyboard input suppresses review keys', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'w10-reasons-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const store = new DecisionsStore(dir), reason = '</textarea><script>123</script> & 中文';
  for (const action of ['selected','rejected']) {
    await store.upsert([{unitId:'unit:a', action, reason}]); assert.equal((await store.read())[0].reason,reason);
  }
  await store.upsert([{unitId:'unit:b',action:'selected',reason:'字'.repeat(500)}]);
  await assert.rejects(store.upsert([{unitId:'unit:a', action:'selected'},
    {unitId:'unit:b',action:'rejected',reason:'字'.repeat(501)}]), /500/);
  assert.equal((await store.read()).find(d=>d.unitId==='unit:a').action,'rejected');
  await assert.rejects(store.upsert([{unitId:'unit:a',reason:5}]), /string/);
  for (const key of ['1','2','3','l','e','Enter','Escape']) assert.equal(keyboardAction({key}, true, true), null);
});
test('free reason included in JSON/CSV export with quote escaping', () => {
  const rows = buildReport({ units:[{id:'unit:a',itemIds:['a']}],results:[{unitId:'unit:a'}],
    groups:[{unitIds:['unit:a'],ranking:[{unitId:'unit:a'}]}],items:[{id:'a'}],
    decisions:[{unitId:'unit:a',action:'selected',reason:'手势 "自然"'}] });
  assert.equal(rows[0].decisionReason,'手势 "自然"'); assert.match(reportCsv(rows), /手势 ""自然""/);
});
test('RTMW eyes complete missing ROI, preserve explicit eyes and leave inputs untouched', () => {
  const p=person(), face={box:[.3,.15,.6,.4],eyesAssessed:false};
  const next=completeEyeRois([face],[p]); assert.equal(next.length,1);
  assert.equal(next[0].eyeRoiSource,'rtmw-68'); assert.ok(focusRegionBox(next[0],'eyes')); assert.equal(face.eyeBoxes,undefined);
  const explicit={...face,eyeBoxes:[[.35,.2,.4,.25]]};
  assert.deepEqual(completeEyeRois([explicit],[p])[0],explicit);
  const inferred=completeEyeRois([],[p]); assert.equal(inferred.length,1); assert.equal(inferred[0].eyesAssessed,false);
});
test('ROI abstains for low confidence, invalid coordinates and ambiguous faces', () => {
  const p=person(), faces=[{box:[.3,.15,.6,.4]},{box:[.31,.16,.61,.41]}];
  assert.ok(completeEyeRois(faces,[p]).every(f=>!f.eyeBoxes));
  p.keypoints.points[60][2]=.1; assert.deepEqual(completeEyeRois([],[p]),[]);
  p.keypoints.points[60]=[NaN,.2,.9]; assert.deepEqual(completeEyeRois([],[p]),[]);
});

test('actual proxy rejects a write without reaching upstream and counts every request', async t => {
  const http = await import('node:http');
  const { createReadOnlyEagleProxy } = await import('../scripts/eagle-readonly-proxy.mjs');
  const reached = [];
  const upstream = http.createServer((req, res) => { reached.push(req.method); res.end('{}'); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await listen(upstream);
  const proxy = createReadOnlyEagleProxy(`http://127.0.0.1:${upstream.address().port}`);
  await listen(proxy.server);
  t.after(async () => { await close(proxy.server); await close(upstream); });
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  assert.equal((await fetch(base+'/api/item/update', {method:'POST',body:'{}'})).status,405);
  assert.equal((await fetch(base+'/api/library/switch', {method:'POST',body:'{"libraryPath":"safe.library"}'})).status,405);
  assert.equal((await fetch(base+'/api/item/list')).status,200);
  assert.deepEqual(reached,['GET']);
  assert.deepEqual(proxy.summary(), {'POST /api/item/update':1,'POST /api/library/switch':1,'GET /api/item/list':1});
  assert.equal(proxy.requests[0].allowed,false);
});

test('proxy permits only explicitly listed library switches and logs a target hash', async t => {
  const http = await import('node:http');
  const { createReadOnlyEagleProxy } = await import('../scripts/eagle-readonly-proxy.mjs');
  const reached = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    reached.push({ method: req.method, path: req.url, body: JSON.parse(body) }); res.end('{}');
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await listen(upstream);
  const proxy = createReadOnlyEagleProxy(`http://127.0.0.1:${upstream.address().port}`,
    { switchLibraries: ['safe.library', '未删减.library'] });
  await listen(proxy.server);
  t.after(async () => { await close(proxy.server); await close(upstream); });
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  for (const body of [{ libraryPath: 'unknown.library' }, { libraryPath: '未删减.library' },
    { libraryPath: 'safe.library', extra: true }, { libraryPath: null }]) {
    assert.equal((await fetch(base+'/api/library/switch', { method: 'POST', body: JSON.stringify(body) })).status,405);
  }
  assert.equal((await fetch(base+'/api/item/update', { method: 'POST', body: '{}' })).status,405);
  assert.equal((await fetch(base+'/api/library/switch',
    { method: 'POST', body: JSON.stringify({ libraryPath: 'safe.library' }) })).status,200);
  assert.deepEqual(reached, [{ method: 'POST', path: '/api/library/switch', body: { libraryPath: 'safe.library' } }]);
  const entry = proxy.requests.at(-1);
  assert.equal(entry.kind, 'library-switch'); assert.match(entry.targetHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(entry).includes('safe.library'),false);
});

test('proxy fails closed when its durable request audit cannot be written', async t => {
  const http = await import('node:http');
  const { createReadOnlyEagleProxy } = await import('../scripts/eagle-readonly-proxy.mjs');
  let reached = false;
  const upstream = http.createServer((req, res) => { reached = true; res.end('{}'); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await listen(upstream);
  const proxy = createReadOnlyEagleProxy(`http://127.0.0.1:${upstream.address().port}`,
    { auditRequest: async () => { throw new Error('Disk unavailable'); } });
  await listen(proxy.server);
  t.after(async () => { await close(proxy.server); await close(upstream); });
  assert.equal((await fetch(`http://127.0.0.1:${proxy.server.address().port}/api/library/info`)).status,503);
  assert.equal(reached,false); assert.equal(proxy.requests[0].allowed,false);
});
