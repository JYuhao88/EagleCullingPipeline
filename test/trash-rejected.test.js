import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleReviewRoute } from '../src/server/review-routes.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'trash-rejected-'));
  await writeFile(path.join(dir, 'decisions.json'), JSON.stringify([
    { unitId: 'u1', action: 'rejected', source: 'human' },
    { unitId: 'u2', action: 'selected', source: 'human' },
    { unitId: 'gone', action: 'rejected', source: 'human' }]));
  const data = { run: { id: 'r', libraryPath: '/fixture.library' },
    groups: [{ unitIds: ['u1', 'u2', 'u3', 'gone'], suggested: { u3: 'rejected' } }],
    units: [{ id: 'u1', primaryItemId: 'jpg', itemIds: ['jpg', 'raw'] }, { id: 'u2', primaryItemId: 'b' },
      { id: 'u3', primaryItemId: 'c' }, { id: 'gone', primaryItemId: 'missing' }],
    items: [{ id: 'jpg', name: 'IMG_1', ext: 'jpg' }, { id: 'raw', name: 'IMG_1', ext: 'cr3' }] };
  const trashed = [], checks = [];
  const api = { assertLibrary: async library => checks.push(library),
    itemInfo: async id => { if (id === 'missing') throw new Error('not found'); return { id }; },
    moveToTrash: async ids => trashed.push(...ids) };
  const responses = [];
  const ctx = { api, runStore: { dir: () => dir, get: async () => structuredClone(data) },
    json: (_res, code, body) => responses.push({ code, body }) };
  const post = body => handleReviewRoute({ method: 'POST', url: '/runs/r/trash-rejected' }, {},
    { ...ctx, readBody: async () => body });
  return { dir, api, trashed, checks, responses, post };
}

test('trash cleanup previews and moves only photos the user marked rejected, skipping files no longer in Eagle', async () => {
  const { dir, trashed, checks, responses, post } = await fixture();
  try {
    await post({ apply: false });
    assert.deepEqual(responses.at(-1), { code: 200, body: { dryRun: true, verified: true, units: 2, count: 2, skipped: 1,
      files: ['IMG_1.jpg', 'IMG_1.cr3'] } });
    assert.equal(trashed.length, 0, 'a preview never moves anything');
    await post({ apply: true });
    assert.equal(responses.at(-1).code, 400); assert.equal(trashed.length, 0, 'apply needs the typed confirmation');
    await post({ apply: true, confirm: 'MOVE_TO_TRASH' });
    assert.equal(responses.at(-1).code, 200);
    assert.deepEqual(trashed, ['jpg', 'raw'], 'AI-suggested rejects and kept photos stay');
    assert.deepEqual(responses.at(-1).body.trash, [{ id: 'jpg', ok: true }, { id: 'raw', ok: true }]);
    assert.ok(checks.every(library => library === '/fixture.library'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('trash cleanup refuses to move anything when the Eagle library cannot be confirmed', async () => {
  const { dir, api, trashed, post } = await fixture();
  try {
    api.assertLibrary = async () => { throw new Error('library mismatch'); };
    await assert.rejects(post({ apply: true, confirm: 'MOVE_TO_TRASH' }), /library mismatch/);
    delete api.assertLibrary;
    await assert.rejects(post({ apply: true, confirm: 'MOVE_TO_TRASH' }), /无法确认 Eagle 资源库/);
    assert.equal(trashed.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
