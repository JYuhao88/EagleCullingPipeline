import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReviewRoute, writeAiTags } from '../src/server/review-routes.js';
import { itemAnalysisModel } from '../src/server/item-analysis.js';
import { mountInspector } from '../src/plugin/inspector/inspector.js';

function fixture() {
  const data = { run: { id: 'tags', libraryPath: '/fixture.library' }, groups: [],
    units: [{ id: 'u', primaryItemId: 'jpg', itemIds: ['jpg', 'raw'] }],
    items: [{ id: 'jpg', width: 600, height: 900 }],
    results: [{ unitId: 'u', flags: ['blurry'], aiTags: [{ tag: 'AI·海边', source: 'scene', score: .9 }] }] };
  const live = new Map(['jpg', 'raw'].map(id => [id, { id, tags: ['旅行', 'AI·旧标签', 'AI精选'], star: 5 }]));
  const writes = [], checks = [];
  const api = { assertLibrary: async library => checks.push(library), itemInfo: async id => structuredClone(live.get(id)),
    updateItem: async row => { writes.push(row); Object.assign(live.get(row.id), row); } };
  return { data, live, writes, checks, api };
}
test('AI apply replaces only its prefix on every paired file, keeps current user tags and never sends stars', async () => {
  const { data, api, live, writes, checks } = fixture();
  live.get('raw').tags.push('新标签');
  const result = await writeAiTags(api, data);
  assert.equal(result.updated, 2); assert.deepEqual(checks, Array(3).fill('/fixture.library'));
  assert.deepEqual(live.get('jpg').tags, ['旅行', 'AI精选', 'AI·海边']);
  assert.deepEqual(live.get('raw').tags, ['旅行', 'AI精选', '新标签', 'AI·海边']);
  assert.equal(live.get('jpg').star, 5); assert.ok(writes.every(row => !Object.hasOwn(row, 'star')));
  assert.equal((await writeAiTags(api, data)).updated, 0);
});
test('AI clear removes only AI· and refuses writes if library or current tags cannot be verified', async () => {
  const { data, api, live, writes } = fixture();
  await writeAiTags(api, data, { clear: true });
  assert.deepEqual(live.get('jpg'), { id: 'jpg', tags: ['旅行', 'AI精选'], star: 5 });
  writes.length = 0;
  api.assertLibrary = async () => { throw new Error('library mismatch'); };
  await assert.rejects(writeAiTags(api, data), /library mismatch/); assert.equal(writes.length, 0);
  api.assertLibrary = async () => {};
  api.itemInfo = async id => id === 'raw' ? {} : live.get(id);
  await assert.rejects(writeAiTags(api, data), /未开始写入/); assert.equal(writes.length, 0);
});
test('AI apply and clear share the writeback queue and read fresh tags', async () => {
  const { data, api, live, writes } = fixture();
  const responses = [];
  const ctx = { api, runStore: { dir: () => '/fixture', get: async () => structuredClone(data) },
    json: (_res, code, body) => responses.push({ code, body }) };
  await Promise.all(['apply', 'clear'].map(mode => handleReviewRoute({ method: 'POST',
    url: `/runs/tags/ai-tags/${mode}` }, {}, ctx)));
  assert.deepEqual(responses.map(row => row.code), [200, 200]); assert.equal(writes.length, 4);
  assert.deepEqual(live.get('jpg').tags, ['旅行', 'AI精选']);
});
test('old item analysis derives tags without mutating results and keeps stored scene tags', () => {
  const { data } = fixture();
  assert.equal(itemAnalysisModel(data, 'u').aiTags[0].tag, 'AI·海边');
  delete data.results[0].aiTags;
  const tags = itemAnalysisModel(data, 'u').aiTags.map(row => row.tag);
  assert.ok(tags.includes('AI·模糊')); assert.ok(tags.includes('AI·竖构图'));
  assert.equal(data.results[0].aiTags, undefined);
});
test('inspector patches AI chips and requires two clicks for both task actions with exact paired item count', async () => {
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], hidden: false, disabled: false, dataset: {},
    classList: { add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, addEventListener() {} });
  const buttons = ['apply', 'clear'].map(mode => ({ ...element(), dataset: { aiTags: mode } }));
  const root = { hidden: false, querySelector: id => {
    if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);
  }, querySelectorAll: selector => selector === '[data-ai-tags]' ? buttons : [], createElement: element };
  const analysis = { runId: 'tags', unitId: 'u', runName: '旅行', focus: '清晰', groupMembers: [],
    aiTags: [{ tag: 'AI·海边', source: 'scene' }] };
  const queue = [{ unitId: 'u', primaryItemId: 'jpg', itemIds: ['jpg', 'raw'] }];
  const posts = [];
  const view = mountInspector({ root, eagle: { library: { path: '/fixture.library' },
    item: { getSelected: async () => [{ id: 'jpg' }], getByIds: async () => [] } },
  storage: { getItem: () => null }, session: null, fetchImpl: async (url, options = {}) => {
    if (options.method === 'POST') posts.push(url);
    return { ok: true, json: async () => options.method === 'POST' ? { updated: 2 }
      : url.includes('/queue') ? { queue } : analysis };
  } });
  try {
    await view.refresh(true); await new Promise(resolve => setTimeout(resolve, 10));
    const chips = root.querySelector('#aiTags').children;
    assert.equal(chips[0].textContent, 'AI·海边');
    await view.refresh(true); assert.equal(root.querySelector('#aiTags').children, chips);
    await view.writeAiTags('apply'); assert.equal(posts.length, 0); assert.match(buttons[0].textContent, /写入 2 张/);
    await view.writeAiTags('apply'); assert.equal(posts.length, 1); assert.match(posts[0], /ai-tags\/apply$/);
    await view.writeAiTags('clear'); assert.equal(posts.length, 1); assert.match(buttons[1].textContent, /清除 2 张/);
    await view.writeAiTags('clear'); assert.equal(posts.length, 2); assert.match(posts[1], /ai-tags\/clear$/);
    assert.equal(root.querySelector('#aiTagsStatus').textContent, '已清除 2 张');
  } finally { view.dispose(); }
});
