import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRulesRouter } from '../src/server/rules-routes.js';
const rule = (id, extra = {}) => ({
  id, title: id, statement: '测试可见判断', aspect: 'pose', severity: 'hint',
  check: { by: 'teacher' }, sources: [], exceptions: [], ...extra,
});
const course = { slug: 'sample', title: '合成课程', source: 'test-source', episodes: 3 };
const ev = (episode = 1, extra = {}) => ({
  courseSlug: 'sample', locator: { source: 'test-source', episode, start: 65, end: 95 },
  kind: 'source', paraphrase: '测试转述', ...extra,
});
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'courses-review-'));
  const root = path.join(dir, 'src/rules');
  await mkdir(path.join(root, 'candidates'), { recursive: true });
  const put = (name, value) => writeFile(path.join(root, name), JSON.stringify(value));
  await put('portrait.json', { library: 'portrait', version: '0.1.0', rules: [rule('P-ONE')] });
  await put('general.json', { library: 'general', rules: [rule('G-ONE')] });
  await put('candidates/portrait-v0.2-candidates.json', { rules: [rule('P-YD', { status: 'proposed' })] });
  await put('candidates/course-candidates.json', { contractVersion: 1, rules: [
    rule('P-COURSE', { source: 'course:sample', status: 'proposed', evidence: [ev(1), ev(2)] }),
    rule('G-COURSE', { library: 'general', source: 'course:sample', status: 'proposed', evidence: [ev(1)] }),
  ] });
  await put('candidates/course-evidence.json', { contractVersion: 1, courses: [course], evidence:
    ['P-ONE', 'P-YD', 'G-ONE', 'P-COURSE'].map(ruleId => ({ ...ev(1), ruleId, supportCount: 3 })) });
  const router = createRulesRouter({ projectRoot: dir });
  const call = async (route, body) => {
    let status, data;
    const req = body === undefined ? { method: 'GET', url: `/rules/${route}` } :
      { method: 'POST', url: `/rules/${route}`, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    await router(req, { writeHead(code) { status = code; }, end(value) { data = JSON.parse(value); } });
    return { status, data };
  };
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { call, dir };
}

test('course data attaches citations to seed, YD and general rules with distinct episodes', async t => {
  const { call } = await setup(t);
  const { status, data } = await call('data');
  assert.equal(status, 200);
  assert.equal(data.courseCandidates.rules.length, 2);
  assert.equal(data.courseEvidence.courses[0].episodes, 3);
  for (const id of ['P-ONE', 'P-YD', 'G-ONE']) {
    const item = [...data.rules, ...data.referenceRules].find(r => r.id === id);
    assert.equal(item.courseEvidence[0].course.title, '合成课程');
    assert.equal(item.courseEvidence[0].supportCount, 3);
  }
  assert.deepEqual(data.rules.find(r => r.id === 'P-COURSE').courseEvidence.map(e => e.locator.episode), [1, 2]);
});

test('course merge keeps maximum support count and every episode without counting video evidence', async t => {
  const { call } = await setup(t);
  assert.equal((await call('decisions', { ruleId: 'P-COURSE', action: 'merge', targetId: 'P-ONE' })).status, 200);
  const target = (await call('data')).data.rules.find(r => r.id === 'P-ONE');
  assert.deepEqual(target.courseEvidence.map(e => e.locator.episode), [1, 2]);
  assert.equal(target.courseEvidence[0].supportCount, 3);
  assert.equal(target.frequency.videos, 0);
  assert.equal(target.frequency.segments, 0);
});

test('course approval exports separate general draft and preserves formal seed', async t => {
  const { call, dir } = await setup(t);
  const seedPath = path.join(dir, 'src/rules/portrait.json');
  const before = await readFile(seedPath, 'utf8');
  for (const ruleId of ['P-COURSE', 'G-COURSE'])
    assert.equal((await call('decisions', { ruleId, action: 'approve' })).status, 200);
  assert.equal((await call('decisions', { ruleId: 'G-COURSE', action: 'merge', targetId: 'P-ONE' })).status, 400);
  const { data } = await call('export', {});
  assert.ok(data.draft.rules.some(r => r.id === 'P-COURSE'));
  assert.deepEqual(data.courseDrafts.general.rules.map(r => r.id), ['G-COURSE']);
  assert.deepEqual(data.bookDrafts, {});
  assert.equal(await readFile(seedPath, 'utf8'), before);
});


test('equivalent locators merge regardless of field order and keep all supporting episodes', async t => {
  const { call, dir } = await setup(t);
  const files = path.join(dir, 'src/rules/candidates');
  const primary = ev(1, { locator: { end: 95, start: 65, episode: 1, source: 'test-source' } });
  await writeFile(path.join(files, 'course-candidates.json'), JSON.stringify({ contractVersion: 1, rules: [
    rule('P-COURSE', { source: 'course:sample', status: 'proposed',
      evidence: [{ ...primary, supports: [ev(2)], supportCount: 2 }] }),
  ] }));
  await writeFile(path.join(files, 'course-evidence.json'), JSON.stringify({ contractVersion: 1, courses: [course],
    evidence: [{ ...ev(1), ruleId: 'P-COURSE', supports: [ev(3)], supportCount: 2 }] }));
  const { data } = await call('data');
  const citations = data.rules.find(r => r.id === 'P-COURSE').courseEvidence;
  assert.equal(citations.length, 1);
  assert.equal(citations[0].supportCount, 3);
  assert.deepEqual(citations[0].supports.map(e => e.locator.episode), [1, 2, 3]);
});

test('same episode number in different seasons retains both course citations', async t => {
  const { call, dir } = await setup(t);
  const citations = ['season-2', 'season-3'].map(season => ev(1, {
    ruleId: 'P-ONE', locator: { source: 'test-source', course: season, episode: 1, start: 65, end: 95 },
  }));
  await writeFile(path.join(dir, 'src/rules/candidates/course-evidence.json'),
    JSON.stringify({ contractVersion: 1, courses: [course], evidence: citations }));
  const { data } = await call('data');
  assert.deepEqual(data.rules.find(r => r.id === 'P-ONE').courseEvidence.map(e => e.locator.course),
    ['season-2', 'season-3']);
});

test('workbook pages and documents remain distinct course citations', async t => {
  const { call, dir } = await setup(t);
  const citations = [['workbook-a', 3], ['workbook-a', 5], ['workbook-b', 3]].map(([episodeId, page]) => ev(0, {
    ruleId: 'P-ONE', locator: { source: 'test-source', course: 'sample', episode: 0, episodeId, page },
  }));
  await writeFile(path.join(dir, 'src/rules/candidates/course-evidence.json'),
    JSON.stringify({ contractVersion: 1, courses: [course], evidence: citations }));
  const { data } = await call('data');
  assert.deepEqual(data.rules.find(r => r.id === 'P-ONE').courseEvidence.map(e => [e.locator.episodeId, e.locator.page]),
    [['workbook-a', 3], ['workbook-a', 5], ['workbook-b', 3]]);
});

// Exercise the actual browser script with a minimal DOM, without a server or media access.
async function renderReview(data) {
  class Element {
    constructor(tag, text = '', value = '') { this.tag = tag; this.textContent = text; this.value = value; this.children = []; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const nodes = new Map(['message', 'version', 'aspect', 'status', 'source', 'list', 'detail', 'export']
    .map(id => [id, new Element(id)]));
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) },
    location: { protocol: 'http:' },
    Option: class extends Element { constructor(text, value) { super('option', text, value); } },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => data }; },
    setTimeout,
  });
  vm.runInContext(await readFile(new URL('../src/plugin/rules-review.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  return { nodes, requests, detail: () => descendants(nodes.get('detail')) };
}

test('course detail displays episode time range and support count without media access', async () => {
  const citation = ev(2, { course, supportCount: 3, kind: 'counterpoint', bvid: 'BVTEST', t: 12, frame: 'example.jpg',
    supports: [ev(3), ev(4)] });
  const candidate = rule('P-COURSE', { source: 'course:sample', status: 'proposed', evidence: [citation], courseEvidence: [citation] });
  const { detail, requests } = await renderReview({ rules: [candidate], existingIds: [], version: '0.1.0' });
  assert.ok(detail().some(n => n.textContent === '课程出处/例外'));
  assert.ok(detail().some(n => n.textContent === '反向提醒 · 合成课程 · 支持 3 集'));
  for (const episode of [2, 3, 4])
    assert.ok(detail().some(n => n.textContent === `第 ${episode} 集 · 1:05–1:35`));
  assert.ok(!detail().some(n => n.tag === 'img' || n.tag === 'a'));
  assert.deepEqual(requests, ['/rules/data']);
});

test('course detail displays every workbook page without invented timestamps', async () => {
  const locator = { source: 'test-source', course: 'sample', episode: 9, episodeId: 'workbook', page: 3 };
  const citation = ev(9, { course, locator, supports: [{ locator: { ...locator, page: 5 } }] });
  const candidate = rule('P-COURSE', { courseEvidence: [citation] });
  const { detail, requests } = await renderReview({ rules: [candidate], existingIds: [], version: '0.1.0' });
  for (const page of [3, 5])
    assert.ok(detail().some(n => n.textContent === `sample · 第 9 集 · workbook · 讲义第 ${page} 页`));
  assert.ok(!detail().some(n => n.textContent.includes('—–—')));
  assert.ok(!detail().some(n => n.tag === 'img' || n.tag === 'a'));
  assert.deepEqual(requests, ['/rules/data']);
});

test('course filter includes supported YD/reference rules and combines with status and aspect', async () => {
  const data = { version: '0.1.0', existingIds: [], rules: [
    rule('P-YD', { status: 'proposed', courseEvidence: [ev()] }),
    rule('P-COURSE', { status: 'proposed', source: 'course:sample', aspect: 'lighting', courseEvidence: [ev()] }),
    rule('OTHER', { status: 'proposed' }),
  ], referenceRules: [rule('G-ONE', { status: 'reference', courseEvidence: [ev()] })] };
  const { nodes } = await renderReview(data);
  const listed = () => nodes.get('list').children.map(n => n.textContent);
  nodes.get('source').value = 'course'; nodes.get('source').onchange();
  assert.deepEqual(listed(), ['P-YD', 'P-COURSE', 'G-ONE']);
  nodes.get('status').value = 'proposed'; nodes.get('status').onchange();
  assert.deepEqual(listed(), ['P-YD', 'P-COURSE']);
  nodes.get('aspect').value = 'lighting'; nodes.get('aspect').onchange();
  assert.deepEqual(listed(), ['P-COURSE']);
  nodes.get('aspect').value = ''; nodes.get('status').value = ''; nodes.get('source').value = 'other'; nodes.get('source').onchange();
  assert.deepEqual(listed(), ['OTHER']);
});
