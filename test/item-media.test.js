import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createItemMediaRouter } from '../src/server/item-media-routes.js';
import { handleAdjustmentsRoute } from '../src/server/adjustments-routes.js';
import { json, parseBody } from '../src/server/http.js';

async function library(root) {
  const lib = path.join(root, '示例.library'), info = path.join(lib, 'images', 'ITEM1.info');
  await mkdir(info, { recursive: true });
  await writeFile(path.join(lib, 'metadata.json'), JSON.stringify({ folders: [] }));
  // Stored landscape with EXIF orientation 6: upright it is a portrait.
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#468' } }).withMetadata({ orientation: 6 })
    .jpeg().toFile(path.join(info, 'IMG_1.jpg'));
  await writeFile(path.join(info, 'metadata.json'), JSON.stringify({ id: 'ITEM1', name: 'IMG_1', ext: 'jpg', width: 300, height: 200 }));
  return lib;
}

async function serve(route) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!await route(req, res, url)) json(res, 404, { error: 'unrouted' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

test('an unanalyzed photo gets an upright display image, focus points and its own adjustments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'item-media-'));
  const lib = await library(root), runsRoot = path.join(root, 'runs'), cacheRoot = path.join(root, 'cache');
  await mkdir(runsRoot);
  const { base, close } = await serve(createItemMediaRouter({ runStore: { root: runsRoot }, cacheRoot, readBody: parseBody }));
  const query = `libraryPath=${encodeURIComponent(lib)}`;
  try {
    const display = await fetch(`${base}/items/ITEM1/display?${query}&edge=1024`);
    assert.equal(display.status, 200); assert.equal(display.headers.get('x-display-source'), 'sharp');
    const meta = await sharp(Buffer.from(await display.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 300], 'EXIF orientation is applied exactly once');
    assert.ok((await readdir(path.join(cacheRoot, 'display', 'items'))).length, 'kept in the display cache');

    const points = await (await fetch(`${base}/items/ITEM1/focus-points?${query}`)).json();
    assert.deepEqual([points.areas.length, points.width, points.height], [0, 300, 200]);

    assert.deepEqual(await (await fetch(`${base}/items/ITEM1/adjustments?${query}`)).json(), {});
    const put = await fetch(`${base}/items/ITEM1/adjustments?${query}`, { method: 'PUT', body: JSON.stringify({ exposure: 0.5 }) });
    assert.deepEqual(await put.json(), { exposure: 0.5 });
    assert.deepEqual(await (await fetch(`${base}/items/ITEM1/adjustments?${query}`)).json(), { exposure: 0.5 });
    const bad = await fetch(`${base}/items/ITEM1/adjustments?${query}`, { method: 'PUT', body: JSON.stringify({ exposure: 9 }) });
    assert.equal(bad.status, 400);

    assert.equal((await fetch(`${base}/items/NOPE/display?${query}`)).status, 404);
    assert.equal((await fetch(`${base}/items/ITEM1/display?libraryPath=/tmp/x`)).status, 400);
    assert.equal((await fetch(`${base}/items/..%2Fx/display?${query}`)).status, 400);

    // Once analyzed, the photo shows what was set before until it gets its own value; a reset does not bring it back.
    const runStore = { root: runsRoot, dir: id => path.join(runsRoot, id), getRun: async id => (id === 'r1' ? { libraryPath: lib } : null),
      unitData: async () => ({ units: [{ id: 'u1', primaryItemId: 'ITEM1', itemIds: ['ITEM1'] }] }) };
    await mkdir(runStore.dir('r1'));
    const call = async (method, body) => {
      let status, payload;
      const res = { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text); }, setHeader() {} };
      await handleAdjustmentsRoute({ method, url: '/runs/r1/adjustments/u1' }, res, { runStore,
        json: (_, code, value) => { status = code; payload = value; }, readBody: async () => body });
      return { status, payload };
    };
    assert.deepEqual((await call('GET')).payload, { exposure: 0.5 });
    await call('PUT', {});
    assert.deepEqual((await call('GET')).payload, {}, 'the reset sticks');
    assert.deepEqual(await (await fetch(`${base}/items/ITEM1/adjustments?${query}`)).json(), {});
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
